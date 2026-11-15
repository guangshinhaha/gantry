// bin/gantry-check is the one definition of each Node check: the pre-push hook
// and the CI node job both run it (gantry#125). These run the real script with
// fake npm/pnpm/tsc on PATH that record how they were called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "bin/gantry-check");
const CHECKS = ["lint", "format", "typecheck", "test", "audit"];

// A fake command that prints its name and args; exits $FAKE_EXIT (default 0).
function fake(dir, name) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} $*"\nexit "\${FAKE_EXIT:-0}"\n`);
  chmodSync(p, 0o755);
}

function repo(files = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "gantry-check-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(cwd, name, ".."), { recursive: true });
    writeFileSync(join(cwd, name), body);
  }
  return cwd;
}

const pkg = (scripts) => JSON.stringify({ scripts });

function check(cwd, name, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "gantry-check-bin-"));
  fake(bin, "npm");
  fake(bin, "pnpm");
  const summary = join(mkdtempSync(join(tmpdir(), "gantry-check-out-")), "summary");
  writeFileSync(summary, "");
  const r = spawnSync("sh", [script, ...(name ? [name] : [])], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr, summary: readFileSync(summary, "utf8") };
}

test("each check skips with its reason, on stdout and in the step summary, when the repo lacks it", () => {
  const reasons = {
    lint: "Lint skipped: no lint:ci or lint script",
    format: "Format check skipped: no format:check script",
    typecheck: "Typecheck skipped: no tsconfig.json",
    test: "Unit tests skipped: no test script",
    audit: "Dependency audit skipped: no pnpm-lock.yaml or package-lock.json",
  };
  for (const name of CHECKS) {
    const r = check(repo({ "package.json": pkg({}) }), name);
    assert.equal(r.status, 0, `${name}: ${r.err}`);
    assert.equal(r.out, reasons[name]);
    assert.equal(r.summary, `${reasons[name]}\n`);
  }
});

test("a skip outside CI (no GITHUB_STEP_SUMMARY) still succeeds", () => {
  const r = check(repo(), "test", { GITHUB_STEP_SUMMARY: "" });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "Unit tests skipped: no test script");
});

test("scripts run with npm, or pnpm when pnpm-lock.yaml exists", () => {
  const scripts = pkg({ "format:check": "x", test: "x" });
  assert.equal(check(repo({ "package.json": scripts }), "test").out, "npm run test");
  assert.equal(check(repo({ "package.json": scripts, "pnpm-lock.yaml": "" }), "test").out, "pnpm run test");
  assert.equal(check(repo({ "package.json": scripts, "pnpm-lock.yaml": "" }), "format").out, "pnpm run format:check");
});

test("lint prefers lint:ci over lint", () => {
  assert.equal(check(repo({ "package.json": pkg({ lint: "x", "lint:ci": "x" }) }), "lint").out, "npm run lint:ci");
  assert.equal(check(repo({ "package.json": pkg({ lint: "x" }) }), "lint").out, "npm run lint");
});

test("a failing check fails gantry-check with the same exit code", () => {
  const r = check(repo({ "package.json": pkg({ test: "x" }) }), "test", { FAKE_EXIT: "3" });
  assert.equal(r.status, 3);
});

test("typecheck runs the repo's own tsc, and fails loudly when tsconfig exists without it", () => {
  const missing = check(repo({ "tsconfig.json": "{}" }), "typecheck");
  assert.equal(missing.status, 1);
  assert.match(missing.err, /Typecheck failed: tsconfig\.json exists but node_modules\/\.bin\/tsc doesn't/);

  const cwd = repo({ "tsconfig.json": "{}" });
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  fake(join(cwd, "node_modules/.bin"), "tsc");
  assert.equal(check(cwd, "typecheck").out, "tsc --noEmit");
});

test("audit picks the command from the lockfile", () => {
  assert.equal(check(repo({ "pnpm-lock.yaml": "" }), "audit").out, "pnpm audit --audit-level high --prod");
  assert.equal(check(repo({ "package-lock.json": "{}" }), "audit").out, "npm audit --audit-level=high --omit=dev");
  assert.equal(check(repo({ "npm-shrinkwrap.json": "{}" }), "audit").out, "npm audit --audit-level=high --omit=dev");
});

test("an unknown or missing check name is a usage error", () => {
  for (const name of ["bogus", undefined]) {
    const r = check(repo(), name);
    assert.equal(r.status, 2);
    assert.match(r.err, /usage: gantry-check lint\|format\|typecheck\|test\|audit/);
  }
});

// The point of gantry-check: neither caller keeps its own copy of a command.
test("hooks/node.yml pre-push and the ci.yml node job call gantry-check, with no inline copies", () => {
  const hooks = readFileSync(join(root, "hooks/node.yml"), "utf8");
  const prePush = hooks.slice(hooks.indexOf("pre-push:"));
  for (const name of ["format", "typecheck", "test", "audit"]) {
    assert.ok(
      prePush.includes(`run: sh "$(git rev-parse --git-path info/lefthook-remotes)/gantry-main/bin/gantry-check" ${name}\n`),
      `hooks/node.yml gantry-${name} doesn't run gantry-check ${name}`,
    );
  }

  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const steps = { Lint: "lint", "Format check": "format", Typecheck: "typecheck", "Unit tests": "test", "Dependency audit (high+)": "audit" };
  for (const [step, name] of Object.entries(steps)) {
    const at = ci.indexOf(`      - name: ${step}\n`);
    assert.ok(at >= 0, `ci.yml has no "${step}" step`);
    const body = ci.slice(at, ci.indexOf("\n      - ", at + 1));
    assert.match(body, new RegExp(`run: sh "\\$RUNNER_TEMP/gantry-check" ${name}$`, "m"), `ci.yml "${step}" doesn't run gantry-check ${name}`);
  }
  assert.match(ci, /raw\.githubusercontent\.com\/guangshinhaha\/gantry\/\$\{GANTRY_REF\}\/bin\/gantry-check/);

  for (const inline of ["tsc --noEmit", "audit --audit-level", "run --if-present", "Unit tests skipped", "Lint skipped"]) {
    assert.ok(!prePush.includes(inline), `hooks/node.yml still has "${inline}" inline`);
    assert.ok(!ci.includes(inline), `ci.yml still has "${inline}" inline`);
  }
});
