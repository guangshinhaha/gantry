import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, verdictsIn } from "../verdict-check.mjs";

const H = "a".repeat(40);
const OLD = "b".repeat(40);
let n = 0;
const c = (obj, { at, assoc = "OWNER", raw } = {}) => ({
  id: ++n,
  created_at: at ?? `2026-11-08T00:00:${String(n).padStart(2, "0")}Z`,
  author_association: assoc,
  body: raw ?? "```json\n" + JSON.stringify(obj) + "\n```",
});
const v = (verdict, head_sha = H, extra = {}) => ({ pr: 7, head_sha, verdict, evidence: ["node --test: ok"], ...extra });
const run = (comments, over = {}) =>
  evaluate({ prNumber: 7, headSha: H, labels: ["risk:high"], comments, ...over });

test("unlabelled PR is skipped, whatever the comments say", () => {
  assert.equal(run([], { labels: ["bug"] }).status, "skip");
  assert.equal(run([c(v("FAIL"))], { labels: [] }).status, "skip");
});

test("labelled, no verdict: fail", () => {
  assert.equal(run([]).status, "fail");
  assert.equal(run([c(null, { raw: "LGTM" })]).status, "fail");
});

test("verdict at an old head: fail", () => {
  assert.equal(run([c(v("PASS", OLD))]).status, "fail");
});

test("PASS and PASS+NOTES at the current head: pass", () => {
  assert.equal(run([c(v("PASS"))]).status, "pass");
  assert.equal(run([c(v("PASS+NOTES"))]).status, "pass");
});

test("FAIL newer than PASS fails; PASS newer than FAIL passes", () => {
  assert.equal(run([c(v("PASS")), c(v("FAIL"))]).status, "fail");
  assert.equal(run([c(v("FAIL")), c(v("PASS"))]).status, "pass");
});

test("order is by time, not by list position", () => {
  const pass = c(v("PASS"), { at: "2026-11-08T01:00:00Z" });
  const fail = c(v("FAIL"), { at: "2026-11-08T02:00:00Z" });
  assert.equal(run([fail, pass]).status, "fail");
});

test("a FAIL for an old head does not cancel a PASS at the current head", () => {
  assert.equal(run([c(v("PASS")), c(v("FAIL", OLD))]).status, "pass");
});

test("head match is exact: a short prefix is not the head", () => {
  assert.equal(run([c(v("PASS", H.slice(0, 7)))]).status, "fail");
  assert.equal(run([c(v("PASS", H.toUpperCase()))]).status, "pass");
});

test("a verdict for another PR does not count; a missing pr field does", () => {
  assert.equal(run([c(v("PASS", H, { pr: 8 }))]).status, "fail");
  const { pr, ...noPr } = v("PASS");
  assert.equal(run([c(noPr)]).status, "pass");
});

test("comments from untrusted authors are ignored; trusted set is configurable", () => {
  assert.equal(run([c(v("PASS"), { assoc: "NONE" })]).status, "fail");
  assert.equal(run([c(v("PASS"), { assoc: "NONE" })], { trusted: ["NONE"] }).status, "pass");
});

test("label name is configurable and case-insensitive", () => {
  assert.equal(run([], { labels: ["Tier:High"], label: "tier:high" }).status, "fail");
  assert.equal(run([], { labels: ["risk:high"], label: "tier:high" }).status, "skip");
});

test("verdict is read from prose, fences and braces inside strings", () => {
  const body = 'Verified.\n\n{"pr":7,"head_sha":"' + H + '","verdict":"PASS","evidence":["grep \\"{x}\\" ok"]}\nthanks';
  assert.equal(run([c(null, { raw: body })]).status, "pass");
});

test("things that are not verdicts are ignored", () => {
  assert.deepEqual(verdictsIn('{"head_sha":"x","verdict":"MAYBE"}'), []);
  assert.deepEqual(verdictsIn('{"head_sha":1,"verdict":"PASS"}'), []);
  assert.deepEqual(verdictsIn("{not json} [1,2]"), []);
  assert.deepEqual(verdictsIn(null), []);
});

test("two verdicts in one comment: the later one wins", () => {
  const body = JSON.stringify(v("PASS")) + "\n" + JSON.stringify(v("FAIL"));
  assert.equal(run([c(null, { raw: body })]).status, "fail");
});

test("an earlier PASS comment edited to FAIL is newer than a later PASS", () => {
  const pass1 = c(v("PASS"), { at: "2026-11-08T00:00:00Z" });
  const pass2 = c(v("PASS"), { at: "2026-11-08T00:05:00Z" });
  assert.equal(run([pass1, pass2]).status, "pass");
  const edited = { ...pass1, body: "```json\n" + JSON.stringify(v("FAIL")) + "\n```", updated_at: "2026-11-08T00:10:00Z" };
  assert.equal(run([edited, pass2]).status, "fail");
});
