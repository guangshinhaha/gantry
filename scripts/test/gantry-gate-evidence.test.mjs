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

// A pre-push hook like lefthook's: honours LEFTHOOK=0, LEFTHOOK_BIN and
// LEFTHOOK_CONFIG (here: a config with no pre-push, so nothing runs), records
// that it ran, prints its checks and exits `exit`.
const HOOK = (exit, marker) => `#!/bin/sh
[ "\${LEFTHOOK:-1}" = 0 ] && exit 0
[ -n "\${LEFTHOOK_BIN:-}" ] && exec "\$LEFTHOOK_BIN"
[ -n "\${LEFTHOOK_CONFIG:-}" ] && exit 0
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
    fn({ root, origin, work, commit, gate, remoteSha, head: () => git(work, "rev-parse", "HEAD"), hookRan: () => existsSync(marker), hookPath, marker });
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

test("LEFTHOOK* variables in the caller's env do not skip the hook", () =>
  withRepo(({ commit, gate }) => {
    commit("feat: rate", FIX);
    for (const env of [{ LEFTHOOK: "0" }, { LEFTHOOK_BIN: "true" }, { LEFTHOOK_CONFIG: "/dev/null" }]) {
      const r = gate([], env);
      assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.stdout}`);
      assert.match(r.stdout, /3 failing/);
    }
  }, { hook: 1 }));

test("git config passed through the env can't swap the hook", () =>
  withRepo(({ work, commit, gate }) => {
    const dummy = join(work, "..", "dummy-hooks");
    mkdirSync(dummy);
    writeFileSync(join(dummy, "pre-push"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dummy, "pre-push"), 0o755);
    commit("feat: rate", FIX);
    for (const env of [
      { GIT_CONFIG_PARAMETERS: `'core.hookspath'='${dummy}'` },
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: dummy },
    ]) {
      const r = gate([], env);
      assert.equal(r.status, 1, `${Object.keys(env)[0]}: ${r.stdout}`);
      assert.match(r.stdout, /3 failing/);
    }
  }, { hook: 1 }));

test("a hook that can't find lefthook (exit 0) fails the gate", () =>
  withRepo(({ commit, gate, hookPath }) => {
    writeFileSync(hookPath, "#!/bin/sh\necho \"Can't find lefthook in PATH\"\n");
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: pushed fix-1, but the pre-push hook couldn't find lefthook, so no check ran/);
  }));

test("a directory where the hook should be fails, without hanging", () =>
  withRepo(({ commit, gate, hookPath }) => {
    mkdirSync(hookPath);
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: no pre-push hook/);
  }, { hook: null }));

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

test("a commit that only deletes a test is not the test-first commit", () =>
  withRepo(({ work, commit, gate }) => {
    commit("test: old", { "old.test.js": "x\n" });
    git(work, "push", "-q", "origin", "HEAD:main");
    git(work, "fetch", "-q", "origin");
    git(work, "rm", "-q", "old.test.js");
    git(work, "commit", "-q", "-m", "test: drop old");
    const fix = commit("fix: rate", FIX);
    const r = gate(["--bug"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`  ${fix} fix: rate`));
  }));

test("code a merge brings in counts as a fix, named as the merge", () => {
  // A side branch with the fix, merged before the test commit.
  withRepo(({ work, commit, gate }) => {
    git(work, "switch", "-q", "-c", "side");
    commit("fix: rate", FIX);
    git(work, "switch", "-q", "fix-1");
    git(work, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = git(work, "rev-parse", "--short", "HEAD");
    commit("test: rate", TEST);
    const r = gate(["--bug"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`^  ${merge} merge side \\(merge\\)$`, "m"));
  });
  // An evil merge: code changed in the merge commit itself, no test at all.
  withRepo(({ work, commit, gate }) => {
    git(work, "switch", "-q", "-c", "side");
    commit("docs: note", { "NOTE.md": "x\n" });
    git(work, "switch", "-q", "fix-1");
    git(work, "merge", "-q", "--no-ff", "--no-commit", "side");
    writeFileSync(join(work, "app.js"), "export const rate = 2;\n");
    git(work, "add", "app.js");
    git(work, "commit", "-q", "-m", "merge side");
    const r = gate(["--bug"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /merge side \(merge\)/);
  });
});

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

test("changes hidden from git status still fail: assume-unchanged, skip-worktree, untracked off", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    withRepo(({ work, commit, gate, remoteSha }) => {
      commit("feat: rate", FIX);
      git(work, "update-index", flag, "app.js");
      writeFileSync(join(work, "app.js"), "export const rate = 99;\n");
      const r = gate();
      assert.equal(r.status, 1, `${flag}: ${r.stdout}`);
      assert.match(r.stdout, /assume-unchanged or skip-worktree/);
      assert.match(r.stdout, /app\.js/);
      assert.equal(remoteSha(), null);
    });
  }
  withRepo(({ work, commit, gate }) => {
    commit("feat: rate", FIX);
    git(work, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(work, "local.test.js"), "x\n");
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /local\.test\.js/);
  });
});

test("no commits ahead of the base fails", () =>
  withRepo(({ gate }) => {
    const r = gate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: no commits on fix-1 ahead of origin\/main/);
  }));

test("on the default branch it refuses, whatever --base says", () =>
  withRepo(({ work, gate, commit }) => {
    git(work, "switch", "-q", "main");
    commit("feat: rate", FIX);
    const base = git(work, "rev-parse", "origin/main");
    for (const args of [[], ["--base", "refs/remotes/origin/main"], ["--base", base], ["--base", "origin/main~0"]]) {
      const r = gate(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
      assert.match(r.stdout, /^FAIL: on main, a default or base branch/);
    }
    git(work, "switch", "-q", "-c", "master");
    assert.match(gate(["--base", base]).stdout, /^FAIL: on master, a default or base branch/);
  }));

test("with <remote>/HEAD unset, it asks the remote for its default and refuses to push to it", () =>
  withRepo(({ origin, work, commit, gate }) => {
    git(work, "push", "-q", "origin", "main:develop");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/develop");
    git(work, "fetch", "-q", "origin");
    git(work, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    git(work, "switch", "-q", "-c", "develop", "origin/develop");
    commit("feat: rate", FIX);
    const before = git(origin, "rev-parse", "refs/heads/develop");
    for (const args of [[], ["--base", "origin/main"]]) {
      const r = gate(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
      assert.match(r.stdout, /^FAIL: on develop, a default or base branch/);
    }
    assert.equal(git(origin, "rev-parse", "refs/heads/develop"), before, "develop was pushed");
  }));

test("with <remote>/HEAD unset, a feature branch takes the remote's default as its base", () =>
  withRepo(({ origin, work, commit, gate }) => {
    git(work, "push", "-q", "origin", "main:develop");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/develop");
    git(work, "fetch", "-q", "origin");
    git(work, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }));

test("fails closed when neither <remote>/HEAD nor the remote names a default branch", () =>
  withRepo(({ origin, work, commit, gate, remoteSha }) => {
    git(origin, "symbolic-ref", "HEAD", "refs/heads/nowhere");
    git(work, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    commit("feat: rate", FIX);
    for (const args of [[], ["--base", "origin/main"]]) {
      const r = gate(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
      assert.match(r.stdout, /^FAIL: can't determine origin's default branch/);
    }
    assert.equal(remoteSha(), null);
  }));

test("fails closed when ls-remote names no default, even with a stale <remote>/HEAD set", () =>
  withRepo(({ origin, work, commit, gate, remoteSha }) => {
    // origin/HEAD still says main; the remote's real default is develop.
    git(work, "push", "-q", "origin", "main:develop");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/develop");
    git(work, "fetch", "-q", "origin");
    // ls-remote fails, but a push still works.
    git(work, "config", "remote.origin.uploadpack", "false");
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: can't determine origin's default branch/);
    assert.equal(remoteSha(), null);
    git(work, "switch", "-q", "-c", "develop", "origin/develop");
    commit("feat: rate on develop", { "app.js": "export const rate = 3;\n" });
    const before = git(origin, "rev-parse", "refs/heads/develop");
    for (const args of [[], ["--base", "origin/main"]]) {
      const d = gate(args);
      assert.equal(d.status, 1, `${args.join(" ")}: ${d.stdout}`);
      assert.match(d.stdout, /^FAIL: can't determine origin's default branch/);
    }
    assert.equal(git(origin, "rev-parse", "refs/heads/develop"), before, "develop was pushed");
  }));

// A second bare repo as remote.origin.pushurl: the push goes there, not to the
// fetch URL. Its default is `develop`; origin's stays main.
function withPushUrl(fn, { pushDefault = "develop" } = {}) {
  withRepo((ctx) => {
    const { root, work } = ctx;
    const pushRepo = join(root, "push.git");
    git(root, "init", "-q", "--bare", "-b", "main", pushRepo);
    git(work, "push", "-q", pushRepo, "main:main", "main:develop");
    git(pushRepo, "symbolic-ref", "HEAD", `refs/heads/${pushDefault}`);
    git(work, "config", "remote.origin.pushurl", pushRepo);
    const pushSha = (b) => {
      const r = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/heads/${b}`], { cwd: pushRepo, encoding: "utf8", env: ENV });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    fn({ ...ctx, pushRepo, pushSha });
  });
}

test("refuses to push to the default branch of the pushurl's repo, not just the fetch URL's", () =>
  withPushUrl(({ work, commit, gate, pushSha }) => {
    git(work, "switch", "-q", "-c", "develop", "origin/main");
    commit("feat: rate", FIX);
    const before = pushSha("develop");
    for (const args of [[], ["--base", "origin/main"]]) {
      const r = gate(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
      assert.match(r.stdout, /^FAIL: on develop, a default or base branch/);
    }
    assert.equal(pushSha("develop"), before, "develop was pushed to the pushurl's repo");
  }));

test("a feature branch with a pushurl passes and lands in the pushurl's repo", () =>
  withPushUrl(({ commit, gate, pushSha, head }) => {
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(pushSha("fix-1"), head());
  }));

test("fails closed when the pushurl's repo names no default branch", () =>
  withPushUrl(({ commit, gate, pushSha }) => {
    commit("feat: rate", FIX);
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: can't determine the default branch of origin's push URL/);
    assert.equal(pushSha("fix-1"), null);
  }, { pushDefault: "nowhere" }));

test("an untracked .gitignore can't hide files: only committed .gitignore files may", () => {
  // Self-ignoring dir/.gitignore hides itself and dir/evil.test.js from git status.
  withRepo(({ work, commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    mkdirSync(join(work, "dir"));
    writeFileSync(join(work, "dir/.gitignore"), "*\n");
    writeFileSync(join(work, "dir/evil.test.js"), "x\n");
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: untracked \.gitignore/);
    assert.match(r.stdout, /dir\/\.gitignore/);
    assert.equal(remoteSha(), null);
  });
  // The same, under a directory .git/info/exclude hides from git status.
  withRepo(({ work, commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    writeFileSync(join(work, ".git/info/exclude"), "dir/\n");
    mkdirSync(join(work, "dir/sub"), { recursive: true });
    writeFileSync(join(work, "dir/.gitignore"), "*\n");
    writeFileSync(join(work, "dir/sub/evil.test.js"), "x\n");
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /dir\/\.gitignore/);
    assert.equal(remoteSha(), null);
  });
  // Committed .gitignore files, nested ones included, still hide files, and an
  // untracked .gitignore inside a directory they ignore (.cache/) doesn't matter.
  withRepo(({ work, commit, gate, remoteSha, head }) => {
    commit("feat: rate", { ...FIX, ".gitignore": ".cache/\n", "a/b/.gitignore": "*.gen\n", "a/b/keep.js": "x\n" });
    writeFileSync(join(work, "a/b/out.gen"), "x\n");
    mkdirSync(join(work, "a/b/c"));
    writeFileSync(join(work, "a/b/c/deep.gen"), "x\n");
    mkdirSync(join(work, ".cache"));
    writeFileSync(join(work, ".cache/.gitignore"), "*\n");
    writeFileSync(join(work, ".cache/blob"), "x\n");
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(remoteSha(), head());
  });
});

test("untracked files hidden by .git/info/exclude or a global excludesFile fail; .gitignore'd ones don't", () => {
  withRepo(({ work, commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    writeFileSync(join(work, ".git/info/exclude"), "local.test.js\n");
    writeFileSync(join(work, "local.test.js"), "x\n");
    const r = gate();
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: untracked files/);
    assert.match(r.stdout, /local\.test\.js/);
    assert.equal(remoteSha(), null);
  });
  withRepo(({ root, work, commit, gate, remoteSha }) => {
    commit("feat: rate", FIX);
    const excludes = join(root, "global-excludes");
    const config = join(root, "global-config");
    writeFileSync(excludes, "*.local.js\n");
    writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`);
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src/rate.local.js"), "x\n");
    const r = gate([], { GIT_CONFIG_GLOBAL: config });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /src\/rate\.local\.js/);
    assert.equal(remoteSha(), null);
  });
  withRepo(({ work, commit, gate }) => {
    commit("feat: rate", { ...FIX, ".gitignore": "build/\n", "sub/.gitignore": "*.log\n" });
    mkdirSync(join(work, "build"));
    writeFileSync(join(work, "build/out.js"), "x\n");
    writeFileSync(join(work, "sub/run.log"), "x\n");
    const r = gate();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

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
