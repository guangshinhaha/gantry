// The "Generated code is up to date" step of ci.yml's node job (gantry#19).
// Runs the real step script in a throwaway git repo, so a reworded skip or a
// check that misses an untracked file fails here, not on a sandbox PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CI = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const NAME = "Generated code is up to date";

function stepScript() {
  const lines = readFileSync(CI, "utf8").split("\n");
  const step = lines.findIndex((l) => l.trim() === `- name: ${NAME}`);
  assert.ok(step >= 0, `step "${NAME}" not found in ci.yml`);
  const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  assert.ok(run > step, "step has no run: | block");
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

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });

// A committed repo holding gen.txt = "v1", plus an optional dirty file before the step.
// racy: gen.txt's index entry and the index file share this mtime (see the racy test).
function run(codegen, { dirtyBefore, ignore, racy } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "codegen-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "user.name", "t");
  writeFileSync(join(cwd, "gen.txt"), "v1\n");
  writeFileSync(join(cwd, "other.txt"), "o\n");
  if (ignore) writeFileSync(join(cwd, ".gitignore"), `${ignore}\n`);
  if (racy) {
    git(cwd, "config", "core.trustctime", "false");
    utimesSync(join(cwd, "gen.txt"), racy, racy);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "base");
  if (racy) utimesSync(join(git(cwd, "rev-parse", "--absolute-git-dir").trim(), "index"), racy, racy);
  if (dirtyBefore) writeFileSync(join(cwd, dirtyBefore), "install touched me\n");
  const summary = join(cwd, "..", `summary-${Date.now()}-${Math.random()}`);
  writeFileSync(summary, "");
  const r = spawnSync("bash", ["-eo", "pipefail", "-c", stepScript()], {
    cwd,
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, CODEGEN: codegen },
    encoding: "utf8",
  });
  return { ...r, cwd, summary: readFileSync(summary, "utf8"), out: r.stdout + r.stderr };
}

test("no command: skips and says why", () => {
  const r = run("");
  assert.equal(r.status, 0);
  assert.equal(r.summary, "Skipped: no codegen-command given\n");
});

test("output matches what is committed: passes", () => {
  const r = run("echo v1 > gen.txt");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.summary, "");
});

test("stale tracked file: fails and names it", () => {
  const r = run("echo v2 > gen.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /gen\.txt/);
  assert.doesNotMatch(r.out, /other\.txt/);
  assert.match(r.summary, /gen\.txt/);
});

// Racy git (the one-off flake in gantry#140): "v2" has v1's size, so a rewrite
// that keeps gen.txt's mtime leaves its stat matching the index entry, as a fast
// codegen in the commit's second does. git rehashes such an entry only while the
// index file is no older than it, so the copied index must keep the real one's
// mtime. Both mtimes are pinned to one past second and ctime is ignored, so a
// copy with a fresh mtime misses the rewrite every time.
test("a same-size rewrite with an unchanged mtime is still caught (racy git)", () => {
  const racy = 1700000000;
  const ref = join(mkdtempSync(join(tmpdir(), "codegen-ref-")), "stamp");
  writeFileSync(ref, "");
  utimesSync(ref, racy, racy);
  const r = run(`echo v2 > gen.txt && touch -r '${ref}' gen.txt`, { racy });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /gen\.txt/);
});

test("new untracked generated file: fails and names it", () => {
  const r = run("echo x > new-gen.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /new-gen\.txt/);
});

test("both stale and new files are listed", () => {
  const r = run("echo v2 > gen.txt; echo x > new-gen.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /gen\.txt/);
  assert.match(r.out, /new-gen\.txt/);
});

test("the command itself failing fails the step with its own message", () => {
  const r = run("exit 3");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /codegen-command failed/);
});

test("a file the install already regenerated is still stale against HEAD", () => {
  const r = run("true", { dirtyBefore: "gen.txt" });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /gen\.txt/);
});

test("a deleted generated file is caught", () => {
  const r = run("rm gen.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /D\s+gen\.txt/);
});

test("gitignored output is not counted", () => {
  const r = run("echo build > ignored.out", { ignore: "ignored.out" });
  assert.equal(r.status, 0, r.out);
});

test("a failing first command in a chain fails the step", () => {
  const r = run("false; echo v1 > gen.txt");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /codegen-command failed/);
});

test("a multi-line command can't inject a workflow command", () => {
  const r = run("echo '::add-mask::x'\nexit 3");
  const commands = r.out.split("\n").filter((l) => l.startsWith("::") && l !== "::add-mask::x");
  assert.deepEqual(commands, ["::error::codegen-command failed (exit 3)"]);
});

test("non-ASCII file names are printed as is", () => {
  const r = run("echo x > é.json");
  assert.match(r.out, /é\.json/);
});

test("the real index is left alone", () => {
  const r = run("echo x > new-gen.txt");
  assert.equal(git(r.cwd, "diff", "--cached", "--name-only"), "");
});
