// bin/gantry-gate-evidence against throwaway repos: a bare "origin" and a clone
// with a fake pre-push hook. No network, no gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "../../bin/gantry-gate-evidence");

// Git with no user or system config, so a global hooksPath can't leak in.
const ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A pre-push hook like lefthook's: honours LEFTHOOK=0, records that it ran,
// prints its checks and exits `exit`.
const HOOK = (exit, marker) => `#!/bin/sh
[ "\${LEFTHOOK:-1}" = 0 ] && exit 0
echo ran > "${marker}"
echo "gantry-test: ${exit === 0 ? "41 pass" : "3 failing: rate.test.ts"}"
exit ${exit}
`;

// origin (bare, main) + a clone on branch `fix-1` from origin/main, with the hook.
function withRepo(fn, { hook = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gantry-gate-evidence-test-"));
  try {
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const marker = join(root, "hook-ran");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "init", "-q", "-b", "main", work);
    git(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, "app.js"), "export const rate = 1;\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "init");
    git(work, "push", "-q", "origin", "main");
    git(work, "fetch", "-q", "origin");
    git(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(work, "switch", "-q", "-c", "fix-1", "origin/main");
    const hookPath = join(work, ".git/hooks/pre-push");
    if (hook !== null) {
      writeFileSync(hookPath, HOOK(hook, marker));
      chmodSync(hookPath, 0o755);
    }
    const commit = (msg, files) => {
      for (const [p, body] of Object.entries(files)) {
        mkdirSync(dirname(join(work, p)), { recursive: true });
        writeFileSync(join(work, p), body);
      }
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", msg);
      return git(work, "rev-parse", "--short", "HEAD");
    };
    const gate = (args = [], env = {}) => spawnSync(GATE, args, { cwd: work, encoding: "utf8", env: { ...ENV, ...env } });
    const remoteSha = () => {
      const r = spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/fix-1"], { cwd: origin, encoding: "utf8", env: ENV });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    fn({ work, commit, gate, remoteSha, head: () => git(work, "rev-parse", "HEAD"), hookRan: () => existsSync(marker), hookPath, marker });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FIX = { "app.js": "export const rate = 2;\n" };
const TEST = { "app.test.js": "test('rate is 2', () => {});\n" };

test("feature work: pushes the branch, runs the hook and passes with its output", () =>
  withRepo(({ commit, gate, remoteSha, head, hookRan }) => {
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS: pushed fix-1 at [0-9a-f]{40} to origin/);
    assert.match(r.stdout, /41 pass/);
    assert.ok(hookRan());
    assert.equal(remoteSha(), head());
  }));

test("a failing pre-push hook fails the gate with the hook's output, and nothing is pushed", () =>
  withRepo(({ commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: push of fix-1 refused by the pre-push hook or origin/);
    assert.match(r.stdout, /gantry-test: 3 failing: rate\.test\.ts/);
    assert.equal(remoteSha(), null);
  }, { hook: 1 }));

test("LEFTHOOK=0 in the caller's env does not skip the hook", () =>
  withRepo(({ commit, gate }) => {
    commit("feat: rate", FIX);
    const r = gate([], { LEFTHOOK: "0" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /3 failing/);
  }, { hook: 1 }));

test("bug work with a test-only commit before the fix passes", () =>
  withRepo(({ commit, gate, remoteSha, head }) => {
    commit("test: rate is 2", TEST);
    commit("fix: rate", FIX);
    const r = gate(["--bug"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(remoteSha(), head());
  }));

test("bug work with the fix before the test fails, naming the fix commits, and pushes nothing", () =>
  withRepo(({ commit, gate, remoteSha, hookRan }) => {
    const fix = commit("fix: rate", FIX);
    const fix2 = commit("fix: rate again", { "app.js": "export const rate = 3;\n" });
    const t = commit("test: rate", TEST);
    const r = gate(["--bug"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: bug work needs a commit that changes only tests before the fix; these commits change non-test files before the first test-only commit:/);
    assert.match(r.stdout, new RegExp(`^  ${fix} fix: rate$`, "m"));
    assert.match(r.stdout, new RegExp(`^  ${fix2} fix: rate again$`, "m"));
    assert.doesNotMatch(r.stdout, new RegExp(t));
    assert.equal(remoteSha(), null);
    assert.ok(!hookRan());
  }));

test("bug work with no test-only commit fails, naming the commits", () =>
  withRepo(({ commit, gate }) => {
    const fix = commit("fix: rate with its test", { ...FIX, ...TEST });
    const r = gate(["--bug"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no test-only commit comes before these/);
    assert.match(r.stdout, new RegExp(`^  ${fix} fix: rate with its test$`, "m"));
  }));

test("Markdown-only commits count neither as the test nor as the fix", () => {
  withRepo(({ commit, gate }) => {
    commit("docs: plan", { "docs/plan.md": "x\n" });
    commit("test: rate", { ...TEST, "README.md": "y\n" });
    commit("fix: rate", FIX);
    assert.equal(gate(["--bug"]).status, 0);
  });
  withRepo(({ commit, gate }) => {
    const md = commit("docs: plan", { "docs/plan.md": "x\n" });
    const fix = commit("fix: rate", FIX);
    const r = gate(["--bug"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`  ${fix} fix: rate`));
    assert.doesNotMatch(r.stdout, new RegExp(`  ${md} `));
  });
});

test("shell test scripts, *.bats and files under test dirs count as tests", () => {
  for (const file of ["scripts/supply-chain/test.sh", "test/rate.bats", "scripts/test-rate.sh", "lib/rate_test.sh", "tests/fixtures/rate.json", "pkg/rate_test.go", "test_rate.py"]) {
    withRepo(({ commit, gate }) => {
      commit("test: rate", { [file]: "true\n" });
      commit("fix: rate", FIX);
      const r = gate(["--bug"]);
      assert.equal(r.status, 0, `${file}: ${r.stdout}`);
    });
  }
  withRepo(({ commit, gate }) => {
    commit("chore: script", { "scripts/deploy.sh": "true\n" });
    commit("fix: rate", FIX);
    assert.equal(gate(["--bug"]).status, 1, "a non-test shell script is not a test");
  });
});

test("without --bug, fix-before-test is not checked", () =>
  withRepo(({ commit, gate }) => {
    commit("fix: rate", FIX);
    assert.equal(gate().status, 0);
  }));

test("no pre-push hook fails: a push would run no checks", () =>
  withRepo(({ commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: no pre-push hook at .*lefthook install/);
    assert.equal(remoteSha(), null);
  }, { hook: null }));

test("a hook under core.hooksPath is found and run", () =>
  withRepo(({ work, commit, gate, marker, hookRan }) => {
    mkdirSync(join(work, ".githooks"));
    writeFileSync(join(work, ".githooks/pre-push"), HOOK(1, marker));
    chmodSync(join(work, ".githooks/pre-push"), 0o755);
    git(work, "config", "core.hooksPath", ".githooks");
    commit("feat: rate", { ...FIX });
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /3 failing/);
    assert.ok(hookRan());
  }, { hook: null }));

test("uncommitted or untracked files fail before pushing", () =>
  withRepo(({ work, commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    writeFileSync(join(work, "scratch.js"), "x\n");
    const r = gate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: uncommitted or untracked files/);
    assert.match(r.stdout, /scratch\.js/);
    assert.equal(remoteSha(), null);
  }));

test("no commits ahead of the base fails", () =>
  withRepo(({ gate }) => {
    const r = gate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: no commits on fix-1 ahead of origin\/main/);
  }));

test("on the base branch itself it refuses", () =>
  withRepo(({ work, gate }) => {
    git(work, "switch", "-q", "main");
    const r = gate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: on main, the base branch itself/);
  }));

test("a rewritten branch needs --force-with-lease to push", () =>
  withRepo(({ work, commit, gate, remoteSha, head }) => {
    commit("feat: rate", FIX);
    assert.equal(gate().status, 0);
    git(work, "commit", "-q", "--amend", "-m", "feat: rate, reworded");
    const plain = gate();
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /refused/);
    const lease = gate(["--force-with-lease"]);
    assert.equal(lease.status, 0, lease.stdout);
    assert.equal(remoteSha(), head());
  }));

test("--base overrides the default branch", () =>
  withRepo(({ work, commit, gate }) => {
    commit("test: rate", TEST);
    git(work, "branch", "-q", "stack-base");
    commit("fix: rate", FIX);
    const r = gate(["--bug", "--base", "stack-base"]);
    assert.equal(r.status, 1, "only the fix is ahead of stack-base");
    assert.match(r.stdout, /fix: rate/);
  }));

test("bad arguments exit 2", () =>
  withRepo(({ gate }) => {
    for (const args of [["--bogus"], ["--base"], ["--remote", "--bug"], ["extra"]]) {
      const r = gate(args);
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stdout, "");
    }
  }));
