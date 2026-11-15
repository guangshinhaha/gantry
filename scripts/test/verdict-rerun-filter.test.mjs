// Evaluates the real `if:` of verdict-check.yml's rerun job against comment
// events, so a loosened filter shows up here and not as runner noise (gantry#125).
// A small evaluator covers the expression subset the filter uses: property paths,
// 'strings', contains(), ==, && and ||, with GitHub's case-insensitive contains
// and null-as-empty-string rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(new URL("../../.github/workflows/verdict-check.yml", import.meta.url), "utf8");
const IF = wf.split(/^ {2}rerun:\n {4}if: >-\n/m)[1].split(/\n {4}\S/)[0].replace(/\s+/g, " ").trim()
  .replace(/^\$\{\{/, "").replace(/\}\}$/, "");

function evaluate(expr, ctx) {
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  const str = (v) => (v == null ? "" : String(v));
  const contains = (hay, needle) =>
    Array.isArray(hay) ? hay.includes(needle) : str(hay).toLowerCase().includes(str(needle).toLowerCase());
  const js = expr
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))
    .replace(/(?<!["\w])([a-z_][\w-]*(?:\.[\w-]+)+)/gi, (p) => `get(${JSON.stringify(p)})`)
    .replace(/\bcontains\(/g, "contains(")
    .replace(/==/g, "===");
  return new Function("get", "contains", `return (${js});`)(get, contains);
}

const verdict = '```json\n{"pr": 7, "head_sha": "' + "a".repeat(40) + '", "verdict": "PASS", "evidence": []}\n```';
const event = ({ body, from, pr = true, state = "open", assoc = "OWNER", action = "created" } = {}) => ({
  github: {
    event_name: "issue_comment",
    event: {
      action,
      issue: { number: 7, state, ...(pr ? { pull_request: { url: "x" } } : {}) },
      comment: { body, author_association: assoc },
      ...(from !== undefined ? { changes: { body: { from } } } : {}),
    },
  },
  inputs: { "trusted-associations": "OWNER,MEMBER,COLLABORATOR" },
});
const runs = (e) => Boolean(evaluate(IF, e));

test("the filter was found in the workflow", () => {
  assert.match(IF, /head_sha/);
});

test("a plain comment on a PR starts no rerun", () => {
  assert.equal(runs(event({ body: "Pushed a fix, PTAL" })), false);
});

test("prose that only mentions a verdict starts no rerun", () => {
  assert.equal(runs(event({ body: "Verdict: PASS. The verifier will post the JSON." })), false);
});

test("a verdict comment on an open PR reruns", () => {
  assert.equal(runs(event({ body: verdict })), true);
});

test("editing a verdict into prose reruns (old body matched)", () => {
  assert.equal(runs(event({ action: "edited", body: "retracted", from: verdict })), true);
});

test("deleting a verdict comment reruns", () => {
  assert.equal(runs(event({ action: "deleted", body: verdict })), true);
});

test("a verdict on a plain issue starts no rerun", () => {
  assert.equal(runs(event({ body: verdict, pr: false })), false);
});

test("a verdict on a closed PR starts no rerun", () => {
  assert.equal(runs(event({ body: verdict, state: "closed" })), false);
});

test("a stranger's verdict starts no rerun", () => {
  assert.equal(runs(event({ body: verdict, assoc: "NONE" })), false);
});

test("a pull_request event never runs the rerun job", () => {
  const e = event({ body: verdict });
  e.github.event_name = "pull_request";
  assert.equal(runs(e), false);
});
