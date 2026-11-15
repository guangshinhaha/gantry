// scripts/ci-retarget.mjs re-runs a PR's ci after a base change (gantry#134),
// against a fake GitHub: it never calls real gh.
import test from "node:test";
import assert from "node:assert/strict";
import { latestRun, run } from "../ci-retarget.mjs";

const HEAD = "a".repeat(40);
const PATH = ".github/workflows/ci.yml";
const wr = (over) => ({ id: 1, event: "pull_request", path: PATH, head_sha: HEAD, run_number: 1, status: "completed", ...over });
const PULL = { state: "open", draft: false, head: { sha: HEAD }, base: { ref: "main" } };

// `states` replaces the target run's status on each poll; `rerunFails` makes the first re-runs throw.
// `pulls` replaces the PR on each read after the first (a push during the retarget).
function fake({ pull = PULL, pulls = [], runs = [wr()], states = [], rerunFails = 0 } = {}) {
  const calls = { cancel: [], rerun: [], sleeps: 0, order: [] };
  let reads = 0;
  const api = async (p) => {
    if (/\/pulls\//.test(p)) return reads++ === 0 ? pull : (pulls.shift() ?? pull);
    if (/\/actions\/runs\?/.test(p)) return { workflow_runs: runs };
    const id = Number(p.split("/").pop());
    return { ...runs.find((r) => r.id === id), status: states.shift() ?? "completed" };
  };
  return {
    calls, api,
    cancel: async (id) => { calls.cancel.push(id); calls.order.push(`cancel ${id}`); },
    rerun: async (id) => {
      if (rerunFails-- > 0) throw new Error("run is not completed");
      calls.rerun.push(id); calls.order.push(`rerun ${id}`);
    },
    sleep: async () => { calls.sleeps++; },
  };
}
const go = (f, over = {}) => run({ repo: "o/r", pr: 7, path: PATH, api: f.api, cancel: f.cancel, rerun: f.rerun, sleep: f.sleep, pollMs: 1, waitMs: 5, ...over });

test("latestRun takes the newest pull_request run of the ci workflow at the head", () => {
  const runs = [
    wr({ id: 1, run_number: 3 }),
    wr({ id: 2, run_number: 5 }),
    wr({ id: 3, run_number: 9, path: ".github/workflows/ci-retarget.yml" }),
    wr({ id: 4, run_number: 9, event: "push" }),
    wr({ id: 5, run_number: 9, head_sha: "b".repeat(40) }),
    wr({ id: 6, run_number: 9, pull_requests: [{ number: 8 }] }),
  ];
  assert.equal(latestRun(runs, { headSha: HEAD, path: PATH, pr: 7 }).id, 2);
  assert.equal(latestRun([], { headSha: HEAD, path: PATH, pr: 7 }), undefined);
});

test("a base change re-runs the PR's latest ci run", async () => {
  const f = fake({ runs: [wr({ id: 1, run_number: 1 }), wr({ id: 2, run_number: 2 })] });
  const r = await go(f);
  assert.equal(r.status, "rerun", r.reason);
  assert.deepEqual(f.calls.rerun, [2]);
  assert.deepEqual(f.calls.cancel, []);
});

test("a ci run still going on the old base is cancelled, then re-run once it stops", async () => {
  const f = fake({ runs: [wr({ id: 4, status: "in_progress" })], states: ["in_progress", "completed"] });
  const r = await go(f, { waitMs: 50 });
  assert.equal(r.status, "rerun", r.reason);
  assert.deepEqual(f.calls.order, ["cancel 4", "rerun 4"]);
});

test("a cancel that fails because the run just finished still re-runs it", async () => {
  const f = fake({ runs: [wr({ id: 4, status: "in_progress" })] });
  f.cancel = async () => { throw new Error("cannot cancel a completed run"); };
  assert.equal((await go(f)).status, "rerun");
  assert.deepEqual(f.calls.rerun, [4]);
});

test("a run that never stops fails loudly instead of leaving the old green", async () => {
  const f = fake({ runs: [wr({ id: 4, status: "in_progress" })], states: Array(100).fill("in_progress") });
  const r = await go(f);
  assert.equal(r.status, "fail");
  assert.match(r.reason, /Re-run it by hand/);
  assert.deepEqual(f.calls.rerun, []);
});

test("a refused re-run is retried", async () => {
  const f = fake({ rerunFails: 1 });
  assert.equal((await go(f)).status, "rerun");
  assert.deepEqual(f.calls.rerun, [1]);
});

test("re-runs that keep failing fail the job", async () => {
  const f = fake({ rerunFails: 10 });
  const r = await go(f, { waitMs: 1000 });
  assert.equal(r.status, "fail");
  assert.match(r.reason, /Could not re-run run 1/);
});

test("no ci run at the head re-runs nothing (ci-ok is missing, so the merge already waits)", async () => {
  const f = fake({ runs: [] });
  const r = await go(f);
  assert.equal(r.status, "skip");
  assert.deepEqual(f.calls.rerun, []);
});

test("a closed or draft PR re-runs nothing", async () => {
  for (const pull of [{ ...PULL, state: "closed" }, { ...PULL, draft: true }]) {
    const f = fake({ pull });
    assert.equal((await go(f)).status, "skip");
    assert.deepEqual(f.calls.rerun, []);
  }
});

test("no workflow path fails", async () => {
  assert.equal((await go(fake(), { path: "" })).status, "fail");
});

test("a push during the retarget skips the re-run, so the new head's run isn't cancelled", async () => {
  const f = fake({ runs: [wr({ id: 4, status: "in_progress" })], states: ["completed"], pulls: [{ ...PULL, head: { sha: "b".repeat(40) } }] });
  const r = await go(f, { waitMs: 50 });
  assert.equal(r.status, "skip", r.reason);
  assert.match(r.reason, /moved on/);
  assert.deepEqual(f.calls.rerun, []);
});
