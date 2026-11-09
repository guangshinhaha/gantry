// The opt-in smoke step of build.yml (gantry#18): runs the real step script
// against a local HTTP server, with a stub `docker`, and pins down which probe
// the failure names. The workflow's `if: inputs.run-image` is checked by
// reading the file, since that is what keeps the step off by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD = fileURLToPath(new URL("../../.github/workflows/build.yml", import.meta.url));
const text = readFileSync(BUILD, "utf8");

function stepScript(name) {
  const lines = text.split("\n");
  const step = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(step >= 0, `step "${name}" not found`);
  const next = lines.findIndex((l, i) => i > step && /^\s*- /.test(l));
  const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  assert.ok(run > step && (next < 0 || run < next), `step "${name}" has no run: | block`);
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

// Stub docker: `run` succeeds, `inspect` reports the container as running unless
// STUB_EXITED is set, `logs` prints a marker.
const DOCKER = `#!/bin/sh
case "$1" in
  run) echo stub-container-id ;;
  inspect) [ -n "$STUB_EXITED" ] && echo false || echo true ;;
  logs) echo "stub-app-log" ;;
esac
`;

// An app with /health (200), /app (200), /missing.js (404) and, if flaky, a
// /health that answers 503 for its first `warm` requests.
function app({ warm = 0, health = 200 } = {}) {
  let n = 0;
  const server = createServer((req, res) => {
    let code = 404;
    if (req.url === "/health") code = n++ < warm ? 503 : health;
    else if (req.url === "/app") code = 200;
    res.statusCode = code;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function smoke({ probes = "", healthPath = "/health", warm, health, exited = false, timeout = 6, port }) {
  const server = port ? null : await app({ warm, health });
  const p = port ?? server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  writeFileSync(join(dir, "docker"), DOCKER);
  chmodSync(join(dir, "docker"), 0o755);
  const summary = join(dir, "summary");
  writeFileSync(summary, "");
  const out = [];
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepScript("Smoke test")], {
    cwd: dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, PORT: String(p),
      HEALTH_PATH: healthPath, PROBES: probes, TIMEOUT: String(timeout), ...(exited ? { STUB_EXITED: "1" } : {}),
    },
  });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const status = await new Promise((r) => child.on("close", r));
  server?.close();
  return { status, log: out.join(""), summary: readFileSync(summary, "utf8") };
}

test("off by default: every smoke step is gated on run-image, which defaults to false", () => {
  assert.match(text, /run-image:\n(?:\s+.*\n)*?\s+default: false/);
  for (const name of ["Check smoke-test inputs", "Smoke test", "Stop the smoke-test container"]) {
    const i = text.split("\n").findIndex((l) => l.trim() === `- name: ${name}`);
    assert.match(text.split("\n")[i + 1], /if: (always\(\) && )?inputs\.run-image/, name);
  }
});

test("healthy app and passing probes: exit 0, each probe in the summary", async () => {
  const r = await smoke({ probes: "/app\n/missing.js 404\n# a comment\n\n/app 200" });
  assert.equal(r.status, 0, r.log);
  assert.match(r.summary, /passed: GET \/health \(health\)/);
  assert.match(r.summary, /passed: GET \/app -> 200/);
  assert.match(r.summary, /passed: GET \/missing\.js -> 404/);
  assert.doesNotMatch(r.log, /::error/);
});

test("a failing probe is red and the error names it", async () => {
  const r = await smoke({ probes: "/app\n/missing.js 200\n/app 404" });
  assert.equal(r.status, 1);
  assert.match(r.log, /::error title=Smoke probe failed::GET \/missing\.js expected 200, got 404/);
  assert.match(r.log, /::error title=Smoke probe failed::GET \/app expected 404, got 200/);
  assert.match(r.summary, /Smoke probe failed: GET \/missing\.js expected 200, got 404/);
  assert.match(r.summary, /passed: GET \/app -> 200/); // the passing one is still listed
  assert.match(r.log, /stub-app-log/);
});

test("health that comes up late still passes", async () => {
  const r = await smoke({ warm: 2 });
  assert.equal(r.status, 0, r.log);
});

test("health that never answers 2xx fails naming the health probe", async () => {
  const r = await smoke({ health: 500, timeout: 3 });
  assert.equal(r.status, 1);
  assert.match(r.log, /::error title=Smoke probe failed::health GET \/health: no 2xx within 3s \(last status 500\)/);
});

test("a container that exited before answering fails naming the health probe", async () => {
  const r = await smoke({ exited: true });
  assert.equal(r.status, 1);
  assert.match(r.log, /health GET \/health: the container exited/);
});

test("a custom health path is the one probed", async () => {
  const r = await smoke({ healthPath: "/app" });
  assert.equal(r.status, 0, r.log);
  assert.match(r.summary, /passed: GET \/app \(health\)/);
});

test("nothing listening: fails, names health, and does not hang", async () => {
  const r = await smoke({ port: 1, timeout: 3 });
  assert.equal(r.status, 1);
  assert.match(r.log, /health GET \/health: no 2xx within 3s/);
});
