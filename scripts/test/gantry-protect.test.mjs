import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROTECT = join(dirname(fileURLToPath(import.meta.url)), "../../bin/gantry-protect");
const CI_OK = "gantry / ci-ok";

const run = (args, env = process.env) => spawnSync(PROTECT, args, { encoding: "utf8", env });

// The contexts a --dry-run asks GitHub to require, in payload order.
function contexts(...flags) {
  const result = run(["--dry-run", ...flags]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  return payload.rules[0].parameters.required_status_checks.map((check) => check.context);
}

// A fake gh on PATH: logs each `gh api` call, saves stdin, and reports the given
// ruleset id from the lookup.
function withFakeGh(existingId, fn) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-protect-test-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  *--input*) cat > "${dir}/body" ;;
  *--jq*) echo "${existingId}" ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    fn({
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n"),
      body: () => JSON.parse(readFileSync(join(dir, "body"), "utf8")),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Uses the fake gh, so a parser regression can't turn a rejection test into a
// live ruleset write.
function assertRejected(flags, message) {
  withFakeGh("", ({ env, calls }) => {
    const result = run(flags, env);
    assert.equal(result.status, 2, `exit ${result.status}, stdout: ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    assert.throws(calls, { code: "ENOENT" });
  });
}

test("default: requires only ci-ok", () => {
  assert.deepEqual(contexts(), [CI_OK]);
});

test("--require adds to ci-ok, repeatably and in order", () => {
  assert.deepEqual(contexts("--require", "risky-paths / risky-paths"), [
    CI_OK,
    "risky-paths / risky-paths",
  ]);
  assert.deepEqual(contexts("--require", "a", "--require", "b"), [CI_OK, "a", "b"]);
});

test("--no-ci-ok leaves ci-ok out, before or after --require", () => {
  assert.deepEqual(contexts("--no-ci-ok", "--require", "check-router"), ["check-router"]);
  assert.deepEqual(contexts("--require", "check-router", "--no-ci-ok"), ["check-router"]);
});

test("a check named twice is sent once", () => {
  assert.deepEqual(contexts("--require", "a", "--require", "a"), [CI_OK, "a"]);
  assert.deepEqual(contexts("--require", CI_OK), [CI_OK]);
});

test("a check name with JSON metacharacters still gives valid JSON", () => {
  assert.deepEqual(contexts("--no-ci-ok", "--require", 'a "b" \\c'), ['a "b" \\c']);
});

test("the rest of the ruleset is unchanged by the flags", () => {
  const payload = JSON.parse(run(["--dry-run", "--no-ci-ok", "--require", "x"]).stdout);
  assert.equal(payload.name, "gantry");
  assert.equal(payload.enforcement, "active");
  assert.deepEqual(payload.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assert.deepEqual(payload.bypass_actors, [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ]);
  assert.equal(payload.rules[0].type, "required_status_checks");
});

test("rejects an unknown flag", () => {
  assertRejected(["--dry-run", "--bogus"], /unknown option: --bogus/);
});

test("rejects --no-ci-ok with no --require", () => {
  assertRejected(["--dry-run", "--no-ci-ok"], /--no-ci-ok needs at least one --require/);
});

test("rejects --require with no usable check name", () => {
  const message = /--require needs a check name/;
  assertRejected(["--dry-run", "--require"], message);
  assertRejected(["--dry-run", "--require", ""], message);
  assertRejected(["--require", "--dry-run"], message);
  assertRejected(["--dry-run", "--require", "a\nb"], message);
});

test("rejects a check name with spaces at either end", () => {
  const message = /--require needs a check name/;
  assertRejected(["--dry-run", "--require", "   "], message);
  assertRejected(["--dry-run", "--require", "a "], message);
  assertRejected(["--dry-run", "--require", " a"], message);
});

test("rejects a second positional, such as an unquoted check name", () => {
  assertRejected(
    ["owner/repo", "--require", "risky-paths", "/", "risky-paths"],
    /unexpected argument: \//,
  );
});

test("rejects --no-ci-ok together with --require ci-ok", () => {
  assertRejected(["--dry-run", "--no-ci-ok", "--require", CI_OK], /contradicts/);
});

test("a glob in a check name stays literal", () => {
  assert.deepEqual(contexts("--no-ci-ok", "--require", "*"), ["*"]);
});

test("applying creates the ruleset with the requested checks", () =>
  withFakeGh("", ({ env, calls, body }) => {
    const result = run(["owner/repo", "--no-ci-ok", "--require", "check-router"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls()[1], /^api -X POST repos\/owner\/repo\/rulesets /);
    const checks = body().rules[0].parameters.required_status_checks;
    assert.deepEqual(checks, [{ context: "check-router" }]);
  }));

test("applying updates an existing ruleset in place", () =>
  withFakeGh("42", ({ env, calls, body }) => {
    const result = run(["owner/repo", "--require", "check-router"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls()[1], /^api -X PUT repos\/owner\/repo\/rulesets\/42 /);
    assert.match(result.stdout, /required checks: gantry \/ ci-ok, check-router\n/);
    const checks = body().rules[0].parameters.required_status_checks;
    assert.deepEqual(checks, [{ context: CI_OK }, { context: "check-router" }]);
  }));
