#!/usr/bin/env node
// Vercel adapter for preview.yml: find the GitHub deployment Vercel created for
// the PR head SHA, wait for its status to be `success`, print `environment_url`.
//
// Same adapter contract as preview-railway.mjs: write `url=<https://...>` and
// `sha=<head sha>` to $GITHUB_OUTPUT, or exit non-zero with a one-line reason.
//
// Env: GITHUB_TOKEN (needs deployments: read), GITHUB_REPOSITORY, HEAD_SHA,
//      TIMEOUT_MINUTES.
// Deployment protection is not handled here: preview.yml sends the
// x-vercel-protection-bypass header when VERCEL_AUTOMATION_BYPASS_SECRET is set.
import { appendFileSync } from "node:fs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, GITHUB_OUTPUT } = process.env;
const deadline = Date.now() + Number(process.env.TIMEOUT_MINUTES || 10) * 60_000;
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !HEAD_SHA) fail("Missing GITHUB_TOKEN, GITHUB_REPOSITORY or HEAD_SHA.");

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status} on ${path}`);
  return res.json();
}

let last = "no Vercel deployment found for this commit (is the Vercel GitHub app installed?)";
while (Date.now() < deadline) {
  try {
    // Newest first. Skip production deployments: a PR head SHA is a preview.
    const deployments = (await gh(`deployments?sha=${HEAD_SHA}&per_page=30`)).filter(
      (d) => !/^production/i.test(d.environment ?? ""),
    );
    let pending = null;
    for (const d of deployments) {
      const statuses = await gh(`deployments/${d.id}/statuses?per_page=30`); // newest first
      const s = statuses.find((x) => x.state !== "inactive");
      if (!s) continue;
      if (s.state === "success" && s.environment_url) {
        console.log(`Vercel deployment ${d.id} (${d.environment}) is live at ${s.environment_url}`);
        if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${s.environment_url}\nsha=${HEAD_SHA}\n`);
        process.exit(0);
      }
      if (["failure", "error"].includes(s.state)) pending ??= { failed: s.state };
      else pending ??= { state: s.state };
    }
    if (pending?.failed) fail(`Vercel deployment of ${HEAD_SHA.slice(0, 7)} ${pending.failed}.`);
    if (pending) last = `Vercel deployment of ${HEAD_SHA.slice(0, 7)} is ${pending.state}`;
  } catch (e) {
    last = e.message;
  }
  console.log(`waiting: ${last}`);
  await new Promise((r) => setTimeout(r, 15_000));
}
fail(`Preview never came up in time: ${last}.`);
const = ;
