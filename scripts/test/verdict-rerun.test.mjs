import test from "node:test";
import assert from "node:assert/strict";
import { pickRun, run, workflowPath } from "../verdict-rerun.mjs";

const HEAD = "a".repeat(40);
const PATH = ".github/workflows/verdict-check.yml";
const REF = `o/r/${PATH}@refs/heads/main`;
const wr = (over) => ({ id: 1, event: "pull_request", path: PATH, head_sha: HEAD, run_number: 1, run_attempt: 1, status: "completed", ...over });

// A fake GitHub: `runs` is what the run list returns; `states` replaces a run's status on each poll.
function fake({ pull = { state: "open", head: { sha: HEAD } }, runs = [wr()], states = [] } = {}) {
  const calls = { rerun: [], sleeps: 0 };
  const api = async (p) => {
    if (/\/pulls\//.test(p)) return pull;
    if (/\/actions\/runs\?/.test(p)) return { workflow_runs: runs };
    const id = Number(p.split("/").pop());
    return { ...runs.find((r) => r.id === id), status: states.shift() ?? "completed" };
  };
  return { calls, api, rerun: async (id) => calls.rerun.push(id), sleep: async () => { calls.sleeps++; } };
}
const go = (f, over = {}) =>
  run({ repo: "o/r", pr: 7, assoc: "OWNER", workflowRef: REF, api: f.api, rerun: f.rerun, sleep: f.sleep, pollMs: 1, waitMs: 5, ...over });

test("workflowPath reads the caller's file from workflow_ref", () => {
  assert.equal(workflowPath(REF), PATH);
  assert.equal(workflowPath("nonsense"), null);
  assert.equal(workflowPath(undefined), null);
});

test("pickRun takes the newest pull_request run of this workflow at the head", () => {
  const runs = [
    wr({ id: 1, run_number: 3 }),
    wr({ id: 2, run_number: 5 }),
    wr({ id: 3, run_number: 9, path: ".github/workflows/ci.yml" }),
    wr({ id: 4, run_number: 9, event: "issue_comment" }),
    wr({ id: 5, run_number: 9, head_sha: "b".repeat(40) }),
  ];
  assert.equal(pickRun(runs, { headSha: HEAD, path: PATH }).id, 2);
  assert.equal(pickRun([], { headSha: HEAD, path: PATH }), undefined);
});

test("a trusted comment re-runs the PR's run", async () => {
  const f = fake();
  const r = await go(f);
  assert.equal(r.status, "rerun");
  assert.deepEqual(f.calls.rerun, [1]);
});

test("a comment from a stranger re-runs nothing", async () => {
  const f = fake();
  for (const assoc of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined]) {
    assert.equal((await go(f, { assoc })).status, "skip");
  }
  assert.deepEqual(f.calls.rerun, []);
});

test("only the configured associations count", async () => {
  const f = fake();
  assert.equal((await go(f, { assoc: "MEMBER", trusted: ["OWNER"] })).status, "skip");
  assert.equal((await go(f, { assoc: "MEMBER", trusted: ["OWNER", "MEMBER"] })).status, "rerun");
});

test("a closed PR re-runs nothing", async () => {
  const f = fake({ pull: { state: "closed", head: { sha: HEAD } } });
  assert.equal((await go(f)).status, "skip");
  assert.deepEqual(f.calls.rerun, []);
});

test("no run at the head (the caller isn't on the PR yet) skips instead of failing the comment run", async () => {
  const f = fake({ runs: [wr({ head_sha: "b".repeat(40) })] });
  const r = await go(f);
  assert.equal(r.status, "skip");
  assert.deepEqual(f.calls.rerun, []);
});

test("a run still going is waited for, then re-run", async () => {
  const f = fake({ runs: [wr({ status: "in_progress" })], states: ["in_progress", "completed"] });
  const r = await go(f, { waitMs: 100 });
  assert.equal(r.status, "rerun");
  assert.ok(f.calls.sleeps >= 2);
  assert.deepEqual(f.calls.rerun, [1]);
});

test("a run that never finishes fails loudly and is not re-run", async () => {
  const f = fake({ runs: [wr({ status: "in_progress" })], states: Array(50).fill("in_progress") });
  const r = await go(f);
  assert.equal(r.status, "fail");
  assert.deepEqual(f.calls.rerun, []);
});

test("an unreadable workflow_ref fails instead of guessing a workflow", async () => {
  const f = fake();
  assert.equal((await go(f, { workflowRef: "" })).status, "fail");
});

test("a re-run GitHub refuses once (another re-run just started) is retried after the run finishes", async () => {
  const f = fake({ runs: [wr()], states: ["in_progress", "completed"] });
  let first = true;
  const rerun = async (id) => {
    if (first) { first = false; throw new Error("run is still in progress"); }
    f.calls.rerun.push(id);
  };
  const r = await run({ repo: "o/r", pr: 7, assoc: "OWNER", workflowRef: REF, api: f.api, rerun, sleep: f.sleep, pollMs: 1, waitMs: 100 });
  assert.equal(r.status, "rerun");
  assert.deepEqual(f.calls.rerun, [1]);
});

test("a re-run that keeps failing ends as a failure, not a hang", async () => {
  const f = fake();
  const r = await run({ repo: "o/r", pr: 7, assoc: "OWNER", workflowRef: REF, api: f.api, rerun: async () => { throw new Error("boom"); }, sleep: f.sleep, pollMs: 1, waitMs: 100 });
  assert.equal(r.status, "fail");
  assert.match(r.reason, /boom/);
});
