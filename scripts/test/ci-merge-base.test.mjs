// ci.yml's "Merge into the new base" step, on real git repos (gantry#134).
// A re-run after a retarget replays the old event, so github.sha is the merge
// with the old base; the step must test the head merged into the new base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CI = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");

// Every copy of the step's `run: |` block, de-indented.
function scripts() {
  const lines = CI.split("\n");
  const out = [];
  lines.forEach((l, at) => {
    if (l.trim() !== "- name: Merge into the new base") return;
    const run = lines.findIndex((x, i) => i > at && /^\s*run: \|\s*$/.test(x));
    const body = [];
    let pad;
    for (const x of lines.slice(run + 1)) {
      if (x.trim() === "") break;
      const n = x.length - x.trimStart().length;
      pad ??= n;
      if (n < pad) break;
      body.push(x.slice(pad));
    }
    out.push(body.join("\n"));
  });
  return out;
}

// The machine's git config (signing, hooks) stays out of it.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: ENV, encoding: "utf8" }).trim();
const commit = (cwd, file, text, msg) => { writeFileSync(join(cwd, file), text); git(cwd, "add", "-A"); git(cwd, "commit", "-qm", msg); return git(cwd, "rev-parse", "HEAD"); };

// origin: main A -> B (moved on after the retarget), feature A -> F, PR head H on
// feature, and refs/pull/1/merge = M, the old merge of H into feature.
function origin({ conflict = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "merge-base-"));
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work], { env: ENV });
  commit(work, "a.txt", "line\n", "A");
  git(work, "checkout", "-qb", "feature");
  commit(work, "f.txt", "f\n", "F");
  git(work, "checkout", "-qb", "pr");
  const head = commit(work, "a.txt", "head change\n", "H");
  git(work, "checkout", "-q", "feature");
  git(work, "merge", "-q", "--no-ff", "--no-edit", "pr");
  const oldMerge = git(work, "rev-parse", "HEAD");
  git(work, "reset", "-q", "--hard", "HEAD^");
  git(work, "checkout", "-q", "main");
  const base = conflict ? commit(work, "a.txt", "base change\n", "B") : commit(work, "b.txt", "b\n", "B");
  git(work, "update-ref", "refs/pull/1/merge", oldMerge);
  const bare = join(dir, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { env: ENV });
  git(bare, "update-ref", "refs/pull/1/merge", oldMerge);
  return { dir, bare, head, base, oldMerge };
}

// A checkout of github.sha (the old merge), full or depth 1 as actions/checkout does.
function checkout(o, depth) {
  const repo = join(o.dir, `ci-${depth}`);
  execFileSync("git", ["init", "-q", repo], { env: ENV });
  git(repo, "remote", "add", "origin", `file://${o.bare}`);
  git(repo, "fetch", "-q", "--no-tags", ...(depth ? ["--depth", String(depth)] : []), "origin", "+refs/pull/1/merge:refs/remotes/pull/1/merge", ...(depth ? [] : ["+refs/heads/*:refs/remotes/origin/*"]));
  git(repo, "checkout", "-q", "--detach", "refs/remotes/pull/1/merge");
  return repo;
}

function step(repo, o, script = scripts()[0]) {
  try {
    const out = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: repo, env: { ...ENV, BASE: "main", PR_HEAD: o.head }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: e.stdout + e.stderr };
  }
}

test("the secrets and node jobs run the same merge step", () => {
  const s = scripts();
  assert.equal(s.length, 2);
  assert.equal(s[0], s[1]);
});

for (const depth of [0, 1]) {
  test(`a retargeted PR is tested as its head merged into the new base (fetch-depth ${depth})`, () => {
    const o = origin();
    const repo = checkout(o, depth);
    const r = step(repo, o);
    assert.equal(r.status, 0, r.out);
    assert.equal(git(repo, "rev-parse", "HEAD^1"), o.base, "first parent is the new base's tip");
    assert.equal(git(repo, "rev-parse", "HEAD^2"), o.head, "second parent is the PR head, as the secrets scan expects");
    assert.match(r.out, /merged into main/);
  });
}

test("a conflict with the new base fails the step", () => {
  const o = origin({ conflict: true });
  const r = step(checkout(o, 0), o);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /conflicts with its new base main/);
});
