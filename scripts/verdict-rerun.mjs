#!/usr/bin/env node
// Re-run a PR's verdict-check after a verdict comment is posted, edited or deleted.
// Used by the verdict-check workflow. A comment event runs on the default branch,
// so a check it reports would sit on the wrong commit. The required check lives on
// the PR's head, so this re-runs the PR's own latest run and lets it re-read the
// comments. run() is exported for node:test.
//
//   GH_TOKEN=... REPO=owner/name PR=123 ASSOC=OWNER WORKFLOW_REF=owner/name/.github/workflows/x.yml@ref \
//     [TRUSTED=OWNER,MEMBER,COLLABORATOR] node scripts/verdict-rerun.mjs
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];
export const WAIT_MS = 150_000;
export const POLL_MS = 5_000;

/** ".github/workflows/x.yml" from "owner/repo/.github/workflows/x.yml@refs/heads/main". */
export function workflowPath(ref) {
  const m = /^[^/]+\/[^/]+\/(.+?)@/.exec(String(ref ?? ""));
  return m ? m[1] : null;
}

/** The newest pull_request run of `path` at `headSha`, or undefined. */
export function pickRun(runs, { headSha, path }) {
  return runs
    .filter((r) => r.event === "pull_request" && r.path === path && r.head_sha.toLowerCase() === headSha.toLowerCase())
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
}

/**
 * Re-run the PR's latest verdict-check run. Returns { status, reason } where status
 * is "rerun", "skip" or "fail". `api(path)` returns parsed JSON, `rerun(id)` re-runs
 * all jobs of a run, `sleep(ms)` waits. A run still in progress can't be re-run, so
 * this waits for it to finish first (its own result may predate the comment).
 */
export async function run({ repo, pr, assoc, trusted = DEFAULT_TRUSTED, workflowRef, api, rerun, sleep, waitMs = WAIT_MS, pollMs = POLL_MS }) {
  if (!trusted.includes(assoc)) return { status: "skip", reason: `Comment author is ${assoc || "unknown"}, not one of ${trusted.join("/")}: ignored.` };
  const path = workflowPath(workflowRef);
  if (!path) return { status: "fail", reason: `Can't tell which workflow to re-run from "${workflowRef}".` };
  const pull = await api(`repos/${repo}/pulls/${pr}`);
  if (pull.state !== "open") return { status: "skip", reason: `PR #${pr} is ${pull.state}: nothing to re-run.` };
  const headSha = pull.head.sha;
  const runsPath = `repos/${repo}/actions/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
  let target = pickRun((await api(runsPath)).workflow_runs, { headSha, path });
  if (!target) return { status: "skip", reason: `No ${path} run for head ${headSha.slice(0, 7)}: nothing to re-run. Push or relabel to start one.` };
  // A re-run that a faster comment started a moment ago can still read as completed
  // here, and then GitHub refuses ours. Wait for that run to finish and try again:
  // the earlier re-run may have read the comments before this one was posted.
  let waited = 0, lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (; target.status !== "completed"; waited += pollMs) {
      if (waited >= waitMs) return { status: "fail", reason: `Run ${target.id} was still ${target.status} after ${waitMs / 1000}s, so it can't be re-run. Re-run it by hand.` };
      await sleep(pollMs);
      target = await api(`repos/${repo}/actions/runs/${target.id}`);
    }
    try {
      await rerun(target.id);
      return { status: "rerun", reason: `Re-ran ${path} run ${target.id} for head ${headSha.slice(0, 7)}.` };
    } catch (e) {
      lastError = e;
      await sleep(pollMs);
      waited += pollMs;
      target = await api(`repos/${repo}/actions/runs/${target.id}`);
    }
  }
  return { status: "fail", reason: `Could not re-run run ${target.id}: ${lastError?.message ?? lastError}` };
}

const ghJson = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));

async function main() {
  const env = process.env;
  const r = await run({
    repo: env.REPO,
    pr: env.PR,
    assoc: env.ASSOC,
    trusted: (env.TRUSTED || DEFAULT_TRUSTED.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    workflowRef: env.WORKFLOW_REF,
    api: async (p) => ghJson(p),
    rerun: async (id) => { execFileSync("gh", ["run", "rerun", String(id), "--repo", env.REPO], { stdio: "inherit" }); },
    sleep: (ms) => delay(ms),
  });
  console.log(r.status === "fail" ? `::error::${r.reason}` : `${r.status.toUpperCase()}: ${r.reason}`);
  return r.status === "fail" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
