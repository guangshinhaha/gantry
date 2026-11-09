// A stale default gantry-ref is flagged; a current one passes. Real git in a temp repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { defaultPin, stale, PINNED } from "../check-risk-label-pin.mjs";

const CLI = new URL("../check-risk-label-pin.mjs", import.meta.url).pathname;
const workflow = (sha) => `inputs:\n      gantry-ref:\n        description: x\n        type: string\n        default: ${sha}\n      label:\n`;

function repo() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pin-"));
  const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const f of PINNED) writeFileSync(join(root, f), "v1\n");
  git("add", "."); git("commit", "-qm", "one");
  return { root, git, sha: git("rev-parse", "HEAD") };
}

test("defaultPin reads the sha, and nothing for a branch name", () => {
  assert.equal(defaultPin(workflow("a".repeat(40))), "a".repeat(40));
  assert.equal(defaultPin(workflow("main")), null);
});
test("the real workflow has a readable default pin", () => {
  assert.match(defaultPin(readFileSync(new URL("../../.github/workflows/risk-label.yml", import.meta.url), "utf8")), /^[0-9a-f]{40}$/);
});
test("a pin whose scripts match the tree is current", () => {
  const { root, sha } = repo();
  assert.deepEqual(stale(root, sha), []);
});
test("a script edited after the pin is named as stale", () => {
  const { root, sha } = repo();
  writeFileSync(join(root, PINNED[1]), "v2\n");
  assert.deepEqual(stale(root, sha), [PINNED[1]]);
});
test("the CLI exits 1 on a stale pin and 0 on a current one", () => {
  const { root, sha } = repo();
  writeFileSync(join(root, ".github/workflows/risk-label.yml"), workflow(sha));
  assert.equal(spawnSync("node", [CLI, root], { encoding: "utf8" }).status, 0);
  writeFileSync(join(root, PINNED[0]), "v2\n");
  const r = spawnSync("node", [CLI, root], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale.*high-risk-paths\.mjs/);
});
test("the CLI names an unreachable pin instead of crashing with a stack trace", () => {
  const { root } = repo();
  writeFileSync(join(root, ".github/workflows/risk-label.yml"), workflow("b".repeat(40)));
  const r = spawnSync("node", [CLI, root], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /::error::can't compare the pin/);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/);
});
