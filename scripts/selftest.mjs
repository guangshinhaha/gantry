// Self-test: prove a version of gantry's ci.yml still catches what it should.
//
//   node scripts/selftest.mjs --gantry-sha <sha> [--sandbox owner/repo]
//   node scripts/selftest.mjs --cleanup [--sandbox owner/repo]
//
// Opens draft PRs on the sandbox repo whose caller workflow is pinned to
// ci.yml@<sha>, waits for their `ci` runs, and checks each job's result:
//   clean      a normal code change           ci-ok green
//   failing    a failing unit test            node and ci-ok red, at "Unit tests"
//   docs-only  a docs-only change             secret scan runs, node skipped, green
//   key        a planted, made-up key         secrets and ci-ok red, node green
// Exits 1 if any result differs. Needs `gh` signed in with Contents, Pull
// requests and Workflows write plus Actions read on the sandbox (GH_TOKEN).
//
// Runs don't contaminate each other (gantry#36): ci.yml's gitleaks scans every
// branch, so a key on one branch can turn other PRs red. The key scenario runs
// last, after the other runs finish, and its branch is deleted straight after.
// Every branch sits under selftest/, and --cleanup removes leftovers from a
// cancelled run. Callers must run one self-test at a time per sandbox.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PREFIX = "selftest/";
const CALLER = ".github/workflows/ci.yml";
const PIN = /(guangshinhaha\/gantry\/\.github\/workflows\/ci\.yml)@[^\s#]+/;

// A made-up key in the shape gitleaks' generic-api-key rule catches. Random per
// run, so it never matches a real credential.
export function fakeKey() {
  let k = "";
  while (!/[0-9]/.test(k) || !/[a-z]/.test(k)) {
    k = [...randomBytes(32)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  }
  return k;
}

// Each scenario: the files its PR adds or changes, and the job results ci.yml
// must give. `step` names a node step that must be the one that failed.
export function scenarios(runId, { quotaTest }) {
  return [
    {
      name: "clean",
      files: {
        "src/selftest.ts": `// Made by gantry's self-test. Fake data, safe to delete.\nexport const selftestRun = "${runId}";\n`,
      },
      expect: { gate: "success", secrets: "success", node: "success", "ci-ok": "success" },
    },
    {
      name: "failing",
      files: {
        "src/quota.test.ts":
          quotaTest +
          `\ndescribe("gantry self-test", () => {\n  it("fails on purpose", () => expect(remaining(1, 0)).toBe(2));\n});\n`,
      },
      expect: { gate: "success", secrets: "success", node: "failure", "ci-ok": "failure" },
      step: "Unit tests",
    },
    {
      name: "docs-only",
      files: { "docs/selftest.md": `# Self-test\n\nMade by gantry's self-test run ${runId}. Safe to delete.\n` },
      expect: { gate: "success", secrets: "success", node: "skipped", "ci-ok": "success" },
    },
    {
      name: "key",
      last: true,
      files: {
        "selftest-fake-key.txt": `# FAKE key planted by gantry's self-test. Not a real credential.\napi_key = "${fakeKey()}"\n`,
      },
      expect: { gate: "success", secrets: "failure", node: "success", "ci-ok": "failure" },
    },
  ];
}

// Point the sandbox's caller workflow at ci.yml@sha.
export function pinCaller(text, sha) {
  if (!PIN.test(text)) throw new Error(`no gantry ci.yml reference in ${CALLER}`);
  return text.replace(PIN, `$1@${sha}`);
}

// Compare one finished run against a scenario. Returns a list of problems,
// empty when the run is what ci.yml should give.
export function check(sc, run, jobs, sha) {
  const problems = [];
  const used = (run.referenced_workflows || []).find((w) => w.path.includes("/.github/workflows/ci.yml"));
  if (!used || used.sha !== sha) {
    problems.push(`ran ci.yml at ${used ? used.sha : "nothing"}, not ${sha}`);
  }
  const byName = Object.fromEntries(jobs.map((j) => [j.name.split(" / ").pop(), j]));
  for (const [job, want] of Object.entries(sc.expect)) {
    const got = byName[job] ? byName[job].conclusion : "missing";
    if (got !== want) problems.push(`${job}: ${got}, expected ${want}`);
  }
  if (sc.step) {
    const failed = (byName.node?.steps || []).filter((s) => s.conclusion === "failure").map((s) => s.name);
    if (failed.join() !== sc.step) {
      problems.push(`node failed at [${failed.join(", ")}], expected only [${sc.step}]`);
    }
  }
  return problems;
}

function gh(args, input) {
  const out = execFileSync("gh", args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
}
const api = (repo, path, method = "GET", body) =>
  gh(["api", "-X", method, `repos/${repo}/${path}`, ...(body ? ["--input", "-"] : [])], body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString("base64");

function readFile(repo, path, ref) {
  const f = api(repo, `contents/${path}?ref=${encodeURIComponent(ref)}`);
  return { text: Buffer.from(f.content, "base64").toString("utf8"), sha: f.sha };
}

function putFile(repo, branch, path, text, message) {
  let sha;
  try {
    sha = api(repo, `contents/${path}?ref=${encodeURIComponent(branch)}`).sha;
  } catch {
    sha = undefined; // new file
  }
  return api(repo, `contents/${path}`, "PUT", { message, content: b64(text), branch, ...(sha ? { sha } : {}) });
}

function branchSha(repo, branch) {
  return api(repo, `git/ref/heads/${branch}`).object.sha;
}

function makeBranch(repo, branch, fromSha) {
  api(repo, "git/refs", "POST", { ref: `refs/heads/${branch}`, sha: fromSha });
}

// Close every open selftest/ PR and delete every selftest/ branch.
export function cleanup(repo, only) {
  const prs = gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,headRefName"]);
  for (const pr of prs) {
    if (pr.headRefName.startsWith(only || PREFIX)) {
      gh(["api", "-X", "PATCH", `repos/${repo}/pulls/${pr.number}`, "-f", "state=closed"]);
    }
  }
  const refs = api(repo, `git/matching-refs/heads/${only || PREFIX}?per_page=100`) || [];
  for (const r of refs) {
    try {
      api(repo, `git/${r.ref}`, "DELETE");
    } catch (e) {
      if (!String(e.stderr).includes("Reference does not exist")) throw e;
    }
  }
}

async function waitForRun(repo, headSha, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const runs = api(repo, `actions/runs?event=pull_request&head_sha=${headSha}`).workflow_runs;
    const run = runs.find((r) => r.path === CALLER || r.path.startsWith(`${CALLER}@`));
    if (run && run.status === "completed") {
      const jobs = api(repo, `actions/runs/${run.id}/jobs?per_page=100`).jobs;
      return { run, jobs };
    }
    await sleep(10_000);
  }
  throw new Error(`no finished ci run for ${headSha} after ${timeoutMs / 60000} min`);
}

async function runScenario(repo, base, baseSha, sc, runId, sha, log) {
  const branch = `${PREFIX}${runId}/${sc.name}`;
  makeBranch(repo, branch, baseSha);
  for (const [path, text] of Object.entries(sc.files)) {
    putFile(repo, branch, path, text, `test: gantry self-test ${sc.name} (do not merge)`);
  }
  const head = branchSha(repo, branch);
  const pr = gh(["api", "-X", "POST", `repos/${repo}/pulls`, "--input", "-"], {
    title: `selftest ${runId}: ${sc.name} (do not merge)`,
    head: branch,
    base,
    draft: true,
    body: `Opened by gantry's self-test against ci.yml@${sha}. Closed automatically. Fake data only.`,
  });
  log(`${sc.name}: PR #${pr.number}, waiting for ci`);
  try {
    const { run, jobs } = await waitForRun(repo, head, 20 * 60_000);
    return { sc, run, problems: check(sc, run, jobs, sha) };
  } finally {
    if (sc.last) cleanup(repo, branch); // remove the key as soon as its run is done
  }
}

export async function selfTest({ repo, sha, runId, log = console.log }) {
  const base = `${PREFIX}${runId}/base`;
  const mainSha = branchSha(repo, "main");
  makeBranch(repo, base, mainSha);
  try {
    const caller = readFile(repo, CALLER, base);
    putFile(repo, base, CALLER, pinCaller(caller.text, sha), `test: pin gantry ci.yml@${sha.slice(0, 7)} (do not merge)`);
    const baseSha = branchSha(repo, base);
    const quotaTest = readFile(repo, "src/quota.test.ts", base).text;
    const all = scenarios(runId, { quotaTest });
    const go = (sc) => runScenario(repo, base, baseSha, sc, runId, sha, log);
    const results = await Promise.all(all.filter((s) => !s.last).map(go));
    for (const sc of all.filter((s) => s.last)) results.push(await go(sc));
    return results;
  } finally {
    cleanup(repo, `${PREFIX}${runId}/`);
  }
}

export function report(results, sha) {
  const lines = [`### gantry self-test: ci.yml@${sha.slice(0, 7)}`, "", "| scenario | result | run |", "|---|---|---|"];
  for (const r of results) {
    lines.push(`| ${r.sc.name} | ${r.problems.length ? "FAIL: " + r.problems.join("; ") : "ok"} | ${r.run.html_url} |`);
  }
  return lines.join("\n");
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = arg("--sandbox") || "guangshinhaha/gantry-sandbox";
  if (process.argv.includes("--cleanup")) {
    cleanup(repo);
    console.log(`removed ${PREFIX} branches and PRs from ${repo}`);
  } else {
    const sha = arg("--gantry-sha");
    if (!/^[0-9a-f]{40}$/.test(sha || "")) {
      console.error("usage: selftest.mjs --gantry-sha <40-char sha> [--sandbox owner/repo]");
      process.exit(2);
    }
    const runId = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}`
      : `local-${Date.now()}`;
    const results = await selfTest({ repo, sha, runId });
    const md = report(results, sha);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    if (results.some((r) => r.problems.length)) {
      console.error("::error::gantry self-test failed: a check did not fire as expected");
      process.exit(1);
    }
  }
}
