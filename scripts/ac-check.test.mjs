import test from "node:test";
import assert from "node:assert/strict";
import { linkedIssues, acItems, evaluate } from "./ac-check.mjs";

const issue = { number: 9, body: "## Why\nx\n\n## Acceptance criteria\n- [ ] one\n- [ ] two\n\n## Notes\n- [ ] not an AC\n" };

test("linkedIssues finds closing keywords, any case, de-duplicated", () => {
  assert.deepEqual(linkedIssues("Closes #9\nfixes: #12 and Resolved #9"), [9, 12]);
});

test("linkedIssues ignores bare refs, empty template, comments and code", () => {
  assert.deepEqual(linkedIssues("See #4\nCloses #\n<!-- Closes #5 -->\n```\nFixes #6\n```"), []);
});

test("acItems reads only the section and reports tick state", () => {
  assert.deepEqual(acItems(issue.body), [
    { done: false, text: "one" },
    { done: false, text: "two" },
  ]);
  assert.equal(acItems("## Why\nnothing"), null);
});

test("acItems accepts any heading level, X ticks and * bullets", () => {
  assert.deepEqual(acItems("### Acceptance Criteria\n* [X] a\n  - [x] b: evidence"), [
    { done: true, text: "a" },
    { done: true, text: "b: evidence" },
  ]);
});

test("skip when the issue has no AC section or no items", () => {
  assert.equal(evaluate("anything", [{ number: 1, body: "just prose" }]).status, "skip");
  assert.equal(evaluate("anything", []).status, "skip");
});

test("fail when the PR lacks the section", () => {
  assert.equal(evaluate("Closes #9", [issue]).status, "fail");
});

test("fail naming the unticked items", () => {
  const r = evaluate("## Acceptance criteria\n- [x] one\n- [ ] two", [issue]);
  assert.equal(r.status, "fail");
  assert.deepEqual(r.errors, ["Unticked: two"]);
});

test("pass when all ticked", () => {
  const r = evaluate("## Acceptance criteria\n- [x] one: test\n- [x] two: log", [issue]);
  assert.deepEqual(r, { status: "pass", errors: [], warnings: [] });
});

test("warn, not fail, when the PR lists fewer items", () => {
  const r = evaluate("## Acceptance criteria\n- [x] one", [issue]);
  assert.equal(r.status, "pass");
  assert.equal(r.warnings.length, 1);
});

test("unticked items outside the section are ignored", () => {
  const r = evaluate("## Acceptance criteria\n- [x] one\n- [x] two\n\n## How I verified\n- [ ] todo", [issue]);
  assert.equal(r.status, "pass");
});
