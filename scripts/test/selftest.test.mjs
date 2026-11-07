import { test } from "node:test";
import assert from "node:assert/strict";
import { check, fakeKey, pinCaller, scenarios } from "../selftest.mjs";

const SHA = "a".repeat(40);
const all = scenarios("r1", { quotaTest: "// existing tests\n" });
const sc = (name) => all.find((s) => s.name === name);
const run = (sha = SHA) => ({
  referenced_workflows: [{ path: "guangshinhaha/gantry/.github/workflows/ci.yml@" + sha, sha }],
});
const jobs = (results, failedSteps = []) =>
  Object.entries(results).map(([name, conclusion]) => ({
    name: `gantry / ${name}`,
    conclusion,
    steps: name === "node" ? failedSteps.map((s) => ({ name: s, conclusion: "failure" })) : [],
  }));

test("pinCaller points the caller at the sha", () => {
  const text = "    uses: guangshinhaha/gantry/.github/workflows/ci.yml@main\n    permissions:\n";
  assert.equal(pinCaller(text, SHA), `    uses: guangshinhaha/gantry/.github/workflows/ci.yml@${SHA}\n    permissions:\n`);
  assert.throws(() => pinCaller("uses: someone/else/ci.yml@main", SHA), /no gantry ci.yml/);
});

test("the key scenario runs last, alone", () => {
  assert.deepEqual(all.filter((s) => s.last).map((s) => s.name), ["key"]);
});

test("docs-only touches only docs, the others touch code", () => {
  for (const s of all) {
    const docs = Object.keys(s.files).every((f) => f.startsWith("docs/") || f.endsWith(".md"));
    assert.equal(docs, s.name === "docs-only", s.name);
  }
});

test("clean and key mix a doc with code; the key sits in docs/", () => {
  for (const name of ["clean", "key"]) {
    const files = Object.keys(sc(name).files);
    assert.ok(files.some((f) => f.startsWith("docs/")), name);
    assert.ok(files.some((f) => f.startsWith("src/")), name);
  }
  assert.ok(Object.entries(sc("key").files).some(([f, t]) => f.startsWith("docs/") && t.includes("api_key")));
});

test("fake keys are 32 random chars, never two letters in a row", () => {
  const a = fakeKey();
  assert.match(a, /^([a-z][0-9]){16}$/);
  assert.notEqual(a, fakeKey());
  assert.match(sc("key").files["docs/selftest-fake-key.md"], /FAKE/);
});

test("a run matching the scenario has no problems", () => {
  assert.deepEqual(check(sc("clean"), run(), jobs(sc("clean").expect), SHA), []);
  assert.deepEqual(check(sc("failing"), run(), jobs(sc("failing").expect, ["Unit tests"]), SHA), []);
  assert.deepEqual(check(sc("docs-only"), run(), jobs(sc("docs-only").expect), SHA), []);
  assert.deepEqual(check(sc("key"), run(), jobs(sc("key").expect), SHA), []);
});

test("a key that doesn't turn ci-ok red is caught", () => {
  const r = jobs({ gate: "success", secrets: "success", node: "success", "ci-ok": "success" });
  assert.deepEqual(check(sc("key"), run(), r, SHA), ["secrets: success, expected failure", "ci-ok: success, expected failure"]);
});

test("a docs-only run that skips the secret scan is caught", () => {
  const r = jobs({ gate: "success", secrets: "skipped", node: "skipped", "ci-ok": "success" });
  assert.deepEqual(check(sc("docs-only"), run(), r, SHA), ["secrets: skipped, expected success"]);
});

test("a failing run that fails at the wrong step is caught", () => {
  const r = jobs(sc("failing").expect, ["Lint", "Unit tests"]);
  assert.deepEqual(check(sc("failing"), run(), r, SHA), ["node failed at [Lint, Unit tests], expected only [Unit tests]"]);
});

test("a run of another ci.yml version, or a missing job, is caught", () => {
  const r = jobs({ gate: "success", secrets: "success", node: "success" });
  assert.deepEqual(check(sc("clean"), run("b".repeat(40)), r, SHA), [
    `ran ci.yml at ${"b".repeat(40)}, not ${SHA}`,
    "ci-ok: missing, expected success",
  ]);
  assert.deepEqual(check(sc("clean"), {}, jobs(sc("clean").expect), SHA)[0], `ran ci.yml at nothing, not ${SHA}`);
});
