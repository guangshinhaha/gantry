// Runs the gitleaks step of ci.yml's secrets job against a stub `curl`, to pin
// down which build it downloads for each runner OS/arch, that it checks the
// sha256, and that any other platform fails with "unsupported platform"
// instead of looking like a leak (gantry#67).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Stub curl logs its URL and writes junk to -o, so the checksum must fail.
const CURL = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo junk > "$2"; }; shift; done
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
  const log = join(dir, "curl.log");
  let status = 0, out = "";
  try {
    // System dirs only, so a gitleaks installed on this machine isn't found.
    out = execFileSync("bash", ["-e", "-c", stepScript()], {
      env: { PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`, RUNNER_OS: os, RUNNER_ARCH: arch, RUNNER_TEMP: dir, STUB_LOG: log },
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
    // The stub's junk tarball must be rejected before tar or gitleaks run.
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /FAILED|did NOT match/i);
    assert.doesNotMatch(r.out, /stub gitleaks/);
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
