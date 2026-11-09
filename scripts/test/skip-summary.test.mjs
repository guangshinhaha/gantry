// Every self-skip in the shared workflows writes "Skipped: <reason>" to
// $GITHUB_STEP_SUMMARY (gantry#26). Each case runs the real step script from the
// workflow file, so a reworded or dropped line fails here, not on a sandbox PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// The `run: |` block of the step named `name`, de-indented.
function stepScript(workflow, name) {
  const lines = readFileSync(join(root, ".github/workflows", workflow), "utf8").split("\n");
  const step = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(step >= 0, `step "${name}" not found in ${workflow}`);
  const next = lines.findIndex((l, i) => i > step && /^\s*- /.test(l));
  const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  assert.ok(run > step && (next < 0 || run < next), `step "${name}" in ${workflow} has no run: | block`);
  const body = [];
  let indent;
  for (const l of lines.slice(run + 1)) {
    if (l.trim() === "") { body.push(""); continue; }
    const n = l.length - l.trimStart().length;
    indent ??= n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

// Runs a step in `cwd` and returns what it wrote to the summary and outputs.
function runStep(workflow, name, env, cwd = mkdtempSync(join(tmpdir(), "skip-"))) {
  const dir = mkdtempSync(join(tmpdir(), "skip-out-"));
  const summary = join(dir, "summary");
  const output = join(dir, "output");
  writeFileSync(summary, "");
  writeFileSync(output, "");
  const r = spawnSync("bash", ["-eo", "pipefail", "-c", stepScript(workflow, name)], {
    cwd,
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return { summary: readFileSync(summary, "utf8"), output: readFileSync(output, "utf8") };
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoWith(files) {
  const cwd = mkdtempSync(join(tmpdir(), "skip-repo-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "user.name", "t");
  writeFileSync(join(cwd, "README.md"), "x");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  for (const [f, body] of Object.entries(files)) writeFileSync(join(cwd, f), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "pr", "--allow-empty");
  return { cwd, base };
}

const SCOPE = "Find stryker config and files to mutate";

test("mutation: no stryker config", () => {
  const { cwd, base } = repoWith({});
  const r = runStep("mutation.yml", SCOPE, { BASE_SHA: base }, cwd);
  assert.match(r.summary, /^Skipped: no stryker config/);
  assert.match(r.output, /run=false/);
});

test("mutation: no source files changed", () => {
  const { cwd, base } = repoWith({ "stryker.config.mjs": "export default {}", "notes.txt": "hi" });
  const r = runStep("mutation.yml", SCOPE, { BASE_SHA: base }, cwd);
  assert.match(r.summary, /^Skipped: no source files changed/);
  assert.match(r.output, /run=false/);
});

test("mutation: a changed source file is not a skip", () => {
  const { cwd, base } = repoWith({ "stryker.config.mjs": "export default {}", "src.mjs": "1" });
  const r = runStep("mutation.yml", SCOPE, { BASE_SHA: base }, cwd);
  assert.equal(r.summary, "");
  assert.match(r.output, /run=true/);
});

test("risky-paths: not a PR, and a fork PR", () => {
  const gate = "Decide whether to run";
  const notPr = runStep("risky-paths.yml", gate, { PR_NUMBER: "", HEAD_REPO: "", REPO: "o/r" });
  assert.equal(notPr.summary, "Skipped: not a pull request\n");
  assert.match(notPr.output, /run=false/);
  const fork = runStep("risky-paths.yml", gate, { PR_NUMBER: "3", HEAD_REPO: "evil/r", REPO: "o/r" });
  assert.match(fork.summary, /^Skipped: fork PR/);
  assert.match(fork.output, /run=false/);
  const own = runStep("risky-paths.yml", gate, { PR_NUMBER: "3", HEAD_REPO: "o/r", REPO: "o/r" });
  assert.equal(own.summary, "");
  assert.match(own.output, /run=true/);
});

test("risky-paths: no list on the base branch", () => {
  const r = runStep("risky-paths.yml", "Match changed files", { GH_TOKEN: "x", PR: "3" });
  assert.match(r.summary, /^Skipped: no \.github\/gantry-risky-paths on the base branch/);
  assert.match(r.output, /run=false/);
});

test("ac-check: not a PR, and a draft", () => {
  const gate = "Decide whether to run";
  assert.equal(runStep("ac-check.yml", gate, { PR_NUMBER: "", DRAFT: "" }).summary, "Skipped: not a pull request\n");
  const draft = runStep("ac-check.yml", gate, { PR_NUMBER: "3", DRAFT: "true" });
  assert.equal(draft.summary, "Skipped: draft PR\n");
  assert.match(draft.output, /run=false/);
  const ready = runStep("ac-check.yml", gate, { PR_NUMBER: "3", DRAFT: "false" });
  assert.equal(ready.summary, "");
  assert.match(ready.output, /run=true/);
});

test("ac-check: no linked issue with criteria", () => {
  const dir = mkdtempSync(join(tmpdir(), "skip-ac-"));
  const summary = join(dir, "summary");
  writeFileSync(summary, "");
  execFileSync("node", [join(root, "scripts/ac-check.mjs")], {
    env: { PATH: process.env.PATH, PR_BODY: "no issue here", REPO: "o/r", GITHUB_STEP_SUMMARY: summary },
  });
  assert.match(readFileSync(summary, "utf8"), /^Skipped: no linked issue with an Acceptance criteria checklist/);
});

test("review: every skip path writes its reason", () => {
  const gate = "Decide whether to review";
  const pr = { EVENT: "pull_request", HAS_KEY: "true", DRAFT: "false", PR_AUTHOR_TYPE: "User", PR_FROM_FORK: "false", LABEL: "", PR_NUMBER: "7" };
  const cases = [
    [{ ...pr, HAS_KEY: "false" }, "no ANTHROPIC_API_KEY secret"],
    [{ ...pr, DRAFT: "true" }, "draft PR"],
    [{ ...pr, PR_AUTHOR_TYPE: "Bot" }, "bot PR"],
    [{ ...pr, PR_FROM_FORK: "true" }, "fork PR"],
    [{ ...pr, LABEL: "bug" }, "label is not 'review'"],
    [{ ...pr, EVENT: "push" }, "unsupported event push"],
    [{ ...pr, EVENT: "issue_comment", IS_PR_COMMENT: "false" }, "comment is not on a PR"],
    [{ ...pr, EVENT: "issue_comment", IS_PR_COMMENT: "true", ASSOC: "NONE" }, "commenter lacks write access"],
    [{ ...pr, EVENT: "issue_comment", IS_PR_COMMENT: "true", ASSOC: "OWNER", COMMENT_BODY: "hello" }, "not an '@claude review' comment"],
  ];
  for (const [env, reason] of cases) {
    const r = runStep("review.yml", gate, env);
    assert.equal(r.summary, `Skipped: ${reason}\n`, reason);
    assert.match(r.output, /run=false/, reason);
  }
  const go = runStep("review.yml", gate, pr);
  assert.equal(go.summary, "");
  assert.match(go.output, /run=true/);
});
