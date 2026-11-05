#!/usr/bin/env node
// Railway adapter for preview.yml: find this PR's environment, wait until its
// newest deployment is SUCCESS on the PR head SHA, print the public URL.
//
// Adapter contract (so other platforms can slot in): write `url=<https://...>`
// and `sha=<deployed commit>` to $GITHUB_OUTPUT, or exit non-zero with a
// one-line reason on stderr (preview.yml puts it in the PR comment).
//
// Env: RAILWAY_TOKEN, PR_NUMBER, HEAD_SHA, TIMEOUT_MINUTES,
//      RAILWAY_PROJECT_ID (needed for account/workspace tokens),
//      RAILWAY_SERVICE (optional service name when the project has several).
import { appendFileSync } from "node:fs";

const API = "https://backboard.railway.com/graphql/v2";
const { RAILWAY_TOKEN, PR_NUMBER, HEAD_SHA, GITHUB_OUTPUT } = process.env;
const deadline = Date.now() + Number(process.env.TIMEOUT_MINUTES || 10) * 60_000;
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!RAILWAY_TOKEN || !PR_NUMBER || !HEAD_SHA) fail("Missing RAILWAY_TOKEN, PR_NUMBER or HEAD_SHA.");

async function gql(query, variables, headers) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? `HTTP ${res.status}`);
  return body.data;
}

// A project token only sees one environment; PR environments need an
// account/workspace token plus the project id. Support both.
let headers = { "Project-Access-Token": RAILWAY_TOKEN };
let projectId = process.env.RAILWAY_PROJECT_ID;
try {
  projectId ||= (await gql("query { projectToken { projectId } }", {}, headers)).projectToken.projectId;
} catch {
  headers = { Authorization: `Bearer ${RAILWAY_TOKEN}` };
  if (!projectId) fail("RAILWAY_TOKEN is not a project token: set railway-project-id (workflow input) for account/workspace tokens.");
}

const pr = Number(PR_NUMBER);
const envName = (n) => new RegExp(`(^|[^0-9])pr-${pr}$`, "i").test(n);
let last = "no PR environment found";
while (Date.now() < deadline) {
  try {
    const { project } = await gql(
      `query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }`,
      { id: projectId },
      headers,
    );
    const env = project.environments.edges.map((e) => e.node).find((e) => envName(e.name));
    if (!env) last = `no Railway environment named *-pr-${pr} (are PR environments enabled?)`;
    else {
      const { deployments } = await gql(
        `query($input: DeploymentListInput!) { deployments(first: 10, input: $input) {
           edges { node { id status staticUrl meta service: serviceId } } } }`,
        { input: { projectId, environmentId: env.id } },
        headers,
      );
      let nodes = deployments.edges.map((e) => e.node);
      if (process.env.RAILWAY_SERVICE) {
        const { project: p } = await gql(
          `query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
          { id: projectId },
          headers,
        );
        const svc = p.services.edges.map((e) => e.node).find((s) => s.name === process.env.RAILWAY_SERVICE);
        nodes = nodes.filter((n) => n.service === svc?.id);
      }
      const d = nodes.find((n) => n.staticUrl) ?? nodes[0]; // API returns newest first
      if (!d) last = "PR environment has no deployments yet";
      else {
        const sha = d.meta?.commitHash ?? "";
        if (sha !== HEAD_SHA) last = `deployed commit is ${sha.slice(0, 7) || "unknown"}, expected ${HEAD_SHA.slice(0, 7)} (status ${d.status})`;
        else if (d.status !== "SUCCESS") last = `deployment of ${HEAD_SHA.slice(0, 7)} is ${d.status}`;
        else if (!d.staticUrl) last = "deployment has no public domain (generate one in Railway)";
        else {
          const url = `https://${d.staticUrl}`;
          console.log(`Railway deployment ${d.id} is live at ${url}`);
          if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${url}\nsha=${sha}\n`);
          process.exit(0);
        }
        if (["FAILED", "CRASHED"].includes(d.status) && sha === HEAD_SHA) fail(`Railway deployment of ${HEAD_SHA.slice(0, 7)} ${d.status}.`);
      }
    }
  } catch (e) {
    last = `Railway API error: ${e.message}`;
  }
  console.log(`waiting: ${last}`);
  await new Promise((r) => setTimeout(r, 15_000));
}
fail(`Preview never came up in time: ${last}.`);
