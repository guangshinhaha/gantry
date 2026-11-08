// Runs the gitleaks step of ci.yml's secrets job against a stub `curl`, to pin
// down which build it downloads for each runner OS/arch, that it checks the
// sha256, and that any other platform fails with "unsupported platform"
// instead of looking like a leak (gantry#67).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CI = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

// The `run: |` block of the step named gitleaks, de-indented.
function stepScript() {
  const lines = readFileSync(CI, "utf8").split("\n");
  const step = lines.findIndex((l) => /^\s*- name: gitleaks\s*$/.test(l));
  const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  assert.ok(step >= 0 && run > step, "gitleaks step not found in ci.yml");
  const body = [];
  let indent;
  for (const l of lines.slice(run + 1)) {
    if (l.trim() === "") { body.push(""); continue; }
    const n = l.length - l.trimStart().length;
    indent ??= n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

// Stub curl logs its URL and serves a well-formed tarball whose gitleaks only
// says it ran. Its sha256 can't match, so that gitleaks must never run.
const CURL = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "$STUB_TARBALL" "$2"; shift; done
`;
const TAMPERED = `#!/bin/bash
echo "tampered gitleaks ran"
`;
const GITLEAKS = `#!/bin/bash
echo "stub gitleaks $*"
`;

function runStep({ os, arch, onPath = false }) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-secrets-"));
  writeFileSync(join(dir, "curl"), CURL);
  chmodSync(join(dir, "curl"), 0o755);
  if (onPath) {
    writeFileSync(join(dir, "gitleaks"), GITLEAKS);
    chmodSync(join(dir, "gitleaks"), 0o755);
  }
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "gitleaks"), TAMPERED);
  chmodSync(join(src, "gitleaks"), 0o755);
  const tarball = join(dir, "stub.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", src, "gitleaks"]);
  const log = join(dir, "curl.log");
  let status = 0, out = "";
  try {
    // System dirs only, so a gitleaks installed on this machine isn't found.
    out = execFileSync("bash", ["-e", "-c", stepScript()], {
      env: { PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`, RUNNER_OS: os, RUNNER_ARCH: arch, RUNNER_TEMP: dir, STUB_LOG: log, STUB_TARBALL: tarball },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status; out = e.stdout + e.stderr;
  }
  return { status, out, urls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

for (const [os, arch, platform] of [
  ["Linux", "X64", "linux_x64"],
  ["Linux", "ARM64", "linux_arm64"],
  ["macOS", "X64", "darwin_x64"],
  ["macOS", "ARM64", "darwin_arm64"],
]) {
  test(`${os}/${arch} downloads the ${platform} build and checks its sha256`, () => {
    const r = runStep({ os, arch });
    assert.match(r.urls, new RegExp(`/v8\\.30\\.1/gitleaks_8\\.30\\.1_${platform}\\.tar\\.gz`));
    assert.equal(r.urls.trim().split("\n").length, 1, r.urls);
    // The stub's tarball must be rejected before tar or gitleaks run.
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /FAILED|did NOT match/i);
    assert.doesNotMatch(r.out, /tampered gitleaks ran|stub gitleaks/);
  });
}

for (const [os, arch] of [["Windows", "X64"], ["Linux", "ARM"], ["Linux", "X86"], ["", ""]]) {
  test(`${os || "no OS"}/${arch || "no arch"} fails with "unsupported platform", downloads nothing`, () => {
    const r = runStep({ os, arch });
    assert.notEqual(r.status, 0);
    assert.match(r.out, new RegExp(`unsupported platform: ${os}/${arch}\\.`));
    assert.doesNotMatch(r.out, /leaks? found/i);
    assert.equal(r.urls, "");
  });
}

test("a gitleaks already on PATH is used, and the log says so", () => {
  const r = runStep({ os: "Windows", arch: "X64", onPath: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Using gitleaks already on PATH/);
  assert.match(r.out, /stub gitleaks detect --redact --verbose/);
  assert.equal(r.urls, "");
});

// Without `shell: bash`, a Windows runner runs the step in pwsh, which fails on
// the bash syntax before it can say "unsupported platform".
test("the gitleaks step runs in bash on every OS", () => {
  const yml = readFileSync(CI, "utf8");
  const step = yml.slice(yml.indexOf("- name: gitleaks"), yml.indexOf("run: |", yml.indexOf("- name: gitleaks")));
  assert.match(step, /^\s+shell: bash\s*$/m);
});

// The sha256 values from the v8.30.1 release's gitleaks_8.30.1_checksums.txt.
// A hash pasted onto the wrong platform would turn that platform red.
test("each platform pins its own release sha256", () => {
  const yml = readFileSync(CI, "utf8");
  const pinned = Object.fromEntries([...yml.matchAll(/platform=(\w+);\s+sha256=([0-9a-f]{64})/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(pinned, {
    linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    linux_arm64: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    darwin_x64: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    darwin_arm64: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  });
});
