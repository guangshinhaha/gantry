#!/usr/bin/env node
// Re-run a PR's ci after its base changes (gantry#134). Used by the ci-retarget
// workflow, which listens for `edited` so the ci caller doesn't have to: an
// `edited` run in ci itself would be skipped on a title or body edit and, being
// the latest run for the head, would reset the required `gantry / ci-ok`.
//
// A re-run makes ci's latest run for the head unfinished again, so the required
// check blocks the merge at once, and ci's gate tests against the new base (a
// re-run replays the old event, so the gate reads the live base itself). A run
// still going started against the old base, so it is cancelled first.
// run() is exported for node:test.
//
//   GH_TOKEN=... REPO=owner/name PR=123 CI_WORKFLOW=.github/workflows/ci.yml node scripts/ci-retarget.mjs
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const WAIT_MS = 120_000;
export const POLL_MS = 5_000;

/** The newest pull_request run of `path` at `headSha` for this PR, or undefined. */
export function latestRun(runs, { headSha, path, pr }) {
  // Two PRs can share a head; a run that lists its PRs must list this one.
  const ofPr = (r) => !r.pull_requests?.length || r.pull_requests.some((p) => Number(p.number) === Number(pr));
  return runs
    .filter((r) => r.event === "pull_request" && r.path === path && r.head_sha.toLowerCase() === headSha.toLowerCase() && ofPr(r))
    .sort((a, b) => b.run_number - a.run_number)[0];
}

/**
 * Returns { status, reason }: status is "rerun", "skip" or "fail". `api(path)` returns
 * parsed JSON, `cancel(id)` cancels a run, `rerun(id)` re-runs all its jobs, `sleep(ms)` waits.
 */
export async function run({ repo, pr, path, api, cancel, rerun, sleep, waitMs = WAIT_MS, pollMs = POLL_MS }) {
  if (!path) return { status: "fail", reason: "No ci workflow path given (the ci-workflow input)." };
  const pull = await api(`repos/${repo}/pulls/${pr}`);
  if (pull.state !== "open") return { status: "skip", reason: `PR #${pr} is ${pull.state}: nothing to re-run.` };
  if (pull.draft) return { status: "skip", reason: `PR #${pr} is a draft: ci runs when it is marked ready.` };
  const headSha = pull.head.sha;
  const runs = (await api(`repos/${repo}/actions/runs?event=pull_request&head_sha=${headSha}&per_page=100`)).workflow_runs;
  let target = latestRun(runs, { headSha, path, pr });
  // No ci run at this head means no ci-ok either, so the required check already waits.
  if (!target) return { status: "skip", reason: `No ${path} run for head ${headSha.slice(0, 7)}: nothing to re-run. Push to start one.` };

  let waited = 0, lastError;
  if (target.status !== "completed") {
    try {
      await cancel(target.id);
    } catch (e) {
      // It may have finished between the list and the cancel; the wait below sorts it out.
      lastError = e;
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    for (; target.status !== "completed"; waited += pollMs) {
      if (waited >= waitMs) return { status: "fail", reason: `Run ${target.id} was still ${target.status} after ${waitMs / 1000}s, so it can't be re-run against the new base. Re-run it by hand.` };
      await sleep(pollMs);
      target = await api(`repos/${repo}/actions/runs/${target.id}`);
    }
    // A push during the wait starts a run for the new head, and a re-run of the
    // old head's run would join ci's concurrency group and cancel it.
    const live = await api(`repos/${repo}/pulls/${pr}`);
    if (live.head?.sha !== headSha) return { status: "skip", reason: `PR #${pr} moved on from ${headSha.slice(0, 7)}: the run for its new head tests the new base.` };
    try {
      await rerun(target.id);
      return { status: "rerun", reason: `Re-ran ${path} run ${target.id} for head ${headSha.slice(0, 7)} against base ${pull.base.ref}.` };
    } catch (e) {
      // GitHub refuses a re-run of a run that a moment ago still read as running.
      lastError = e;
      await sleep(pollMs);
      waited += pollMs;
      target = await api(`repos/${repo}/actions/runs/${target.id}`);
    }
  }
  return { status: "fail", reason: `Could not re-run run ${target.id}: ${lastError?.message ?? lastError}. Re-run it by hand.` };
}

const ghJson = (p) => JSON.parse(execFileSync("gh", ["api", p], { encoding: "utf8" }));

async function main() {
  const env = process.env;
  const gh = (...args) => execFileSync("gh", [...args, "--repo", env.REPO], { stdio: "inherit" });
  const r = await run({
    repo: env.REPO,
    pr: env.PR,
    path: env.CI_WORKFLOW,
    api: async (p) => ghJson(p),
    cancel: async (id) => gh("run", "cancel", String(id)),
    rerun: async (id) => gh("run", "rerun", String(id)),
    sleep: (ms) => delay(ms),
  });
  console.log(r.status === "fail" ? `::error::${r.reason}` : `${r.status.toUpperCase()}: ${r.reason}`);
  return r.status === "fail" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
