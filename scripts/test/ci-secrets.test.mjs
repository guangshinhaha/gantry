// Runs the secret-scan steps of ci.yml and secrets-scan.yml against stubs.
// Install gitleaks: which build it downloads for each runner OS/arch, that it
// checks the sha256, and that any other platform fails with "unsupported
// platform" instead of looking like a leak (gantry#67).
// gitleaks: which commits each event scans, on a real git repo, so a key on
// another branch or in old history can't turn an unrelated PR red (gantry#36).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CI = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const DAILY = fileURLToPath(new URL("../../.github/workflows/secrets-scan.yml", import.meta.url));

// The step named `name` in a workflow: its whole YAML text, and its `run: |`
// block de-indented.
function step(file, name) {
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step "${name}" not found in ${file}`);
  const indent = lines[at].indexOf("-");
  let end = lines.findIndex((l, i) => i > at && l.trim() !== "" && l.length - l.trimStart().length <= indent);
  if (end < 0) end = lines.length;
  const yaml = lines.slice(at, end);
  const run = yaml.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  assert.ok(run > 0, `step "${name}" has no run: | block`);
  const body = [];
  let pad;
  for (const l of yaml.slice(run + 1)) {
    if (l.trim() === "") { body.push(""); continue; }
    const n = l.length - l.trimStart().length;
    pad ??= n;
    if (n < pad) break;
    body.push(l.slice(pad));
  }
  return { yaml: yaml.join("\n"), script: body.join("\n") };
}
const stepScript = (file, name) => step(file, name).script;

// Runs a step as GitHub's `shell: bash` does. `env` adds to a PATH of system
// dirs only, so a gitleaks installed on this machine isn't found.
function bash(script, { dir, cwd = dir, env = {} }) {
  let status = 0, out = "";
  try {
    out = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd,
      env: {
        PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        GITHUB_STEP_SUMMARY: join(dir, "summary"), GITHUB_OUTPUT: join(dir, "output"), GITHUB_PATH: join(dir, "path"),
        ...env,
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status; out = e.stdout + e.stderr;
  }
  const file = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { status, out, output: file("output"), path: file("path"), summary: file("summary") };
}

function exe(dir, name, body) {
  writeFileSync(join(dir, name), body);
  chmodSync(join(dir, name), 0o755);
}

// Stub curl logs its URL and serves a well-formed tarball whose gitleaks only
// says it ran. Its sha256 can't match, so that gitleaks must never run.
const CURL = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "$STUB_TARBALL" "$2"; shift; done
`;
const TAMPERED = `#!/bin/bash
echo "tampered gitleaks ran"
`;
const GITLEAKS = `#!/bin/bash
echo "stub gitleaks $*"
`;

function runStep({ os, arch, onPath = false }) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-secrets-"));
  exe(dir, "curl", CURL);
  if (onPath) exe(dir, "gitleaks", GITLEAKS);
  const src = join(dir, "src");
  mkdirSync(src);
  exe(src, "gitleaks", TAMPERED);
  const tarball = join(dir, "stub.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", src, "gitleaks"]);
  const log = join(dir, "curl.log");
  const r = bash(stepScript(CI, "Install gitleaks"), {
    dir, env: { RUNNER_OS: os, RUNNER_ARCH: arch, RUNNER_TEMP: dir, STUB_LOG: log, STUB_TARBALL: tarball },
  });
  return { ...r, urls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

for (const [os, arch, platform] of [
  ["Linux", "X64", "linux_x64"],
  ["Linux", "ARM64", "linux_arm64"],
  ["macOS", "X64", "darwin_x64"],
  ["macOS", "ARM64", "darwin_arm64"],
]) {
  test(`${os}/${arch} downloads the ${platform} build and checks its sha256`, () => {
    const r = runStep({ os, arch });
    assert.match(r.urls, new RegExp(`/v8\\.30\\.1/gitleaks_8\\.30\\.1_${platform}\\.tar\\.gz`));
    assert.equal(r.urls.trim().split("\n").length, 1, r.urls);
    // The stub's tarball must be rejected before tar or gitleaks run.
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /FAILED|did NOT match/i);
    assert.doesNotMatch(r.out, /tampered gitleaks ran|stub gitleaks/);
  });
}

for (const [os, arch] of [["Windows", "X64"], ["Linux", "ARM"], ["Linux", "X86"], ["", ""]]) {
  test(`${os || "no OS"}/${arch || "no arch"} fails with "unsupported platform", downloads nothing`, () => {
    const r = runStep({ os, arch });
    assert.notEqual(r.status, 0);
    assert.match(r.out, new RegExp(`unsupported platform: ${os}/${arch}\\.`));
    assert.doesNotMatch(r.out, /leaks? found/i);
    assert.equal(r.urls, "");
  });
}

test("a gitleaks already on PATH is used, and the log says so", () => {
  const r = runStep({ os: "Windows", arch: "X64", onPath: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Using gitleaks already on PATH/);
  assert.equal(r.urls, "");
  assert.equal(r.path, "", "nothing downloaded, so nothing added to PATH");
});

// Without `shell: bash`, a Windows runner runs the step in pwsh, which fails on
// the bash syntax before it can say "unsupported platform".
for (const [file, name] of [[CI, "Install gitleaks"], [CI, "gitleaks"], [DAILY, "Install gitleaks"], [DAILY, "gitleaks (all branches, all history)"]]) {
  test(`${file.split("/").pop()}: "${name}" runs in bash on every OS`, () => {
    assert.match(step(file, name).yaml, /^\s+shell: bash\s*$/m);
  });
}

// One download step in two files. A fix to one (a new platform, a new hash)
// must reach the other.
test("the daily scan installs gitleaks exactly as ci.yml does", () => {
  assert.equal(step(DAILY, "Install gitleaks").yaml, step(CI, "Install gitleaks").yaml);
});

// The sha256 values from the v8.30.1 release's gitleaks_8.30.1_checksums.txt.
// A hash pasted onto the wrong platform would turn that platform red.
test("each platform pins its own release sha256", () => {
  const yml = readFileSync(CI, "utf8");
  const pinned = Object.fromEntries([...yml.matchAll(/platform=(\w+);\s+sha256=([0-9a-f]{64})/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(pinned, {
    linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    linux_arm64: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    darwin_x64: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    darwin_arm64: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  });
});

// --- Which commits the scan covers (gantry#36) ---

// Stands in for gitleaks: "finds a leak" when the commits --log-opts names add
// a line with KEY, as gitleaks' git scan reads `git log -p <log-opts>`. With no
// --log-opts it scans every ref, like gitleaks after a full-history checkout.
const SCANNER = `#!/bin/bash
opts=--all
for a in "$@"; do case "$a" in --log-opts=*) opts="\${a#--log-opts=}" ;; esac; done
echo "stub gitleaks log-opts: $opts"
[ -n "$STUB_EXIT" ] && exit "$STUB_EXIT"
if git log -p $opts | grep -q '^+.*FAKE-KEY'; then echo "leaks found: 1"; exit 1; fi
echo "no leaks found"
`;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function commit(cwd, file, text, msg) {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

// main: init, a key added then removed (old history), then a clean commit.
// other: a key on a branch no PR here touches. Returns the repo and its SHAs.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gantry-scope-"));
  exe(dir, "gitleaks", SCANNER);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  const init = commit(repo, "README.md", "hi\n", "init");
  commit(repo, "old.md", "api_key = FAKE-KEY-old\n", "old key");
  commit(repo, "old.md", "removed\n", "remove old key");
  const main = commit(repo, "a.txt", "a\n", "main moves on");
  git(repo, "checkout", "-q", "-b", "other", init);
  commit(repo, "other.md", "api_key = FAKE-KEY-other\n", "key on another branch");
  git(repo, "checkout", "-q", "main");
  return { dir, repo, init, main };
}

// A PR branch off main with one commit, checked out as refs/pull/N/merge is:
// a merge commit whose parents are the base tip and the PR head.
function prCheckout(f, text) {
  git(f.repo, "checkout", "-q", "-b", "pr", f.main);
  const head = commit(f.repo, "docs.md", text, "pr change");
  git(f.repo, "checkout", "-q", "--detach", f.main);
  git(f.repo, "merge", "-q", "--no-ff", "-m", "merge", head);
  return { head, merge: git(f.repo, "rev-parse", "HEAD") };
}

const scan = (f, env) => bash(stepScript(CI, "gitleaks"), { dir: f.dir, cwd: f.repo, env });

test("PR: a key on another branch and a key in old history leave a clean PR green", () => {
  const f = fixture();
  const pr = prCheckout(f, "just docs\n");
  const r = scan(f, { EVENT: "pull_request", PR_BASE: f.main, PR_HEAD: pr.head, SHA: pr.merge });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`log-opts: ${f.main}\\.\\.${pr.head}`));
  assert.match(r.summary, /1 commit\(s\)/);
  // The same checkout scanned the old way (every ref) does find a key.
  assert.notEqual(bash("gitleaks detect --redact --verbose", { dir: f.dir, cwd: f.repo }).status, 0);
});

test("PR: a key in the PR's own commit fails the scan", () => {
  const f = fixture();
  const pr = prCheckout(f, "api_key = FAKE-KEY-pr\n");
  const r = scan(f, { EVENT: "pull_request", PR_BASE: f.main, PR_HEAD: pr.head, SHA: pr.merge });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /leaks found/);
});

test("PR: a branch that merged its base back in scans its own commits, not the base's", () => {
  const f = fixture();
  // PR branched from init, so main's old key and later commits arrive only
  // through the merge of main into the PR branch.
  git(f.repo, "checkout", "-q", "-b", "pr", f.init);
  const own = commit(f.repo, "docs.md", "api_key = FAKE-KEY-pr\n", "pr key, before merging main");
  git(f.repo, "merge", "-q", "--no-edit", "main");
  const head = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "checkout", "-q", "--detach", f.main);
  git(f.repo, "merge", "-q", "--no-ff", "-m", "merge", head);
  const sha = git(f.repo, "rev-parse", "HEAD");
  const red = scan(f, { EVENT: "pull_request", PR_BASE: f.init, PR_HEAD: head, SHA: sha });
  assert.equal(red.status, 1, red.out);
  assert.match(git(f.repo, "rev-list", `${f.main}..${head}`), new RegExp(own));
  // Same shape without the PR's key: main's old key, now in the PR branch's
  // history through the merge, must not turn it red.
  const g = fixture();
  git(g.repo, "checkout", "-q", "-b", "pr", g.init);
  commit(g.repo, "docs.md", "clean\n", "pr change");
  git(g.repo, "merge", "-q", "--no-edit", "main");
  const h2 = git(g.repo, "rev-parse", "HEAD");
  git(g.repo, "checkout", "-q", "--detach", g.main);
  git(g.repo, "merge", "-q", "--no-ff", "-m", "merge", h2);
  const green = scan(g, { EVENT: "pull_request", PR_BASE: g.init, PR_HEAD: h2, SHA: git(g.repo, "rev-parse", "HEAD") });
  assert.equal(green.status, 0, green.out);
});

test("PR: a stale base.sha doesn't widen the range into base history", () => {
  const f = fixture();
  const pr = prCheckout(f, "just docs\n");
  // base.sha from before main took the old key: the merge ref's base wins.
  const r = scan(f, { EVENT: "pull_request", PR_BASE: f.init, PR_HEAD: pr.head, SHA: pr.merge });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`log-opts: ${f.main}\\.\\.${pr.head}`));
});

test("PR: without a merge commit checked out, it scans base.sha..head", () => {
  const f = fixture();
  const pr = prCheckout(f, "api_key = FAKE-KEY-pr\n");
  git(f.repo, "checkout", "-q", "--detach", pr.head);
  const r = scan(f, { EVENT: "pull_request", PR_BASE: f.main, PR_HEAD: pr.head, SHA: pr.head });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`log-opts: ${f.main}\\.\\.${pr.head}`));
});

test("push: scans the pushed commits, so a direct push with a key fails", () => {
  const f = fixture();
  const sha = commit(f.repo, "b.md", "api_key = FAKE-KEY-push\n", "direct push");
  const r = scan(f, { EVENT: "push", BEFORE: f.main, SHA: sha });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`log-opts: ${f.main}\\.\\.${sha}`));
});

test("push: a clean push stays green despite old history and other branches", () => {
  const f = fixture();
  const sha = commit(f.repo, "b.md", "clean\n", "direct push");
  const r = scan(f, { EVENT: "push", BEFORE: f.main, SHA: sha });
  assert.equal(r.status, 0, r.out);
});

for (const [why, before] of [["a new branch", "0000000000000000000000000000000000000000"], ["a before this clone lacks", "1234567890123456789012345678901234567890"], ["no before", ""]]) {
  test(`push with ${why}: scans the pushed commit's whole history, not other branches`, () => {
    const f = fixture();
    // A clean commit, while main's history and \`other\` both hold a key.
    git(f.repo, "checkout", "-q", "--detach", f.init);
    const clean = scan(f, { EVENT: "push", BEFORE: before, SHA: f.init });
    assert.match(clean.out, /log-opts: HEAD$/m);
    assert.equal(clean.status, 0, clean.out);
    // Its own history is still scanned: main's old key fails it.
    git(f.repo, "checkout", "-q", "main");
    assert.equal(scan(f, { EVENT: "push", BEFORE: before, SHA: f.main }).status, 1);
  });
}

test("any other event scans the checked-out commit's history only", () => {
  const f = fixture();
  git(f.repo, "checkout", "-q", "--detach", f.init);
  const r = scan(f, { EVENT: "workflow_dispatch", SHA: f.init });
  assert.match(r.out, /log-opts: HEAD$/m);
  assert.equal(r.status, 0, r.out);
});

test("a range that can't be resolved fails the step, never passes it", () => {
  const f = fixture();
  const r = scan(f, { EVENT: "pull_request", PR_BASE: "1234567890123456789012345678901234567890", PR_HEAD: f.main, SHA: f.main });
  assert.notEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /no leaks found/);
});

// --- The daily scan ---

const daily = (f, env = {}) => bash(stepScript(DAILY, "gitleaks (all branches, all history)"), { dir: f.dir, cwd: f.repo, env });

test("daily: a key on any branch fails and reports result=leaks", () => {
  const f = fixture();
  const r = daily(f);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /log-opts: --all/);
  assert.match(r.output, /^result=leaks$/m);
});

test("daily: a key only in old history also fails", () => {
  const f = fixture();
  git(f.repo, "branch", "-q", "-D", "other");
  const r = daily(f);
  assert.equal(r.status, 1, r.out);
  assert.match(r.output, /^result=leaks$/m);
});

test("daily: clean everywhere passes with result=clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "gantry-scope-"));
  exe(dir, "gitleaks", SCANNER);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  commit(repo, "README.md", "hi\n", "init");
  const r = daily({ dir, repo });
  assert.equal(r.status, 0, r.out);
  assert.match(r.output, /^result=clean$/m);
});

test("daily: a gitleaks error reports result=error, not a leak", () => {
  const f = fixture();
  const r = daily(f, { STUB_EXIT: "2" });
  assert.equal(r.status, 2, r.out);
  assert.match(r.output, /^result=error$/m);
  assert.doesNotMatch(r.out, /found a key/);
});

// --- The daily scan's alert ---

// Stub gh: answers the open-issue lookup with $STUB_EXISTING and logs every call.
const GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"issues?state=open"*) [ -n "$STUB_EXISTING" ] && echo "$STUB_EXISTING"; exit 0 ;;
  *) echo "https://github.com/o/r/issues/9" ;;
esac
`;

function alert({ existing = "", result }) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-alert-"));
  exe(dir, "gh", GH);
  const log = join(dir, "gh.log");
  const r = bash(stepScript(DAILY, "Open or update the alert issue"), {
    dir, env: { STUB_LOG: log, STUB_EXISTING: existing, REPO: "o/r", RESULT: result, RUN_URL: "https://run/1" },
  });
  return { ...r, calls: readFileSync(log, "utf8") };
}

test("alert: no open issue opens one, linking the run, with no finding details", () => {
  const r = alert({ result: "leaks" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /repos\/o\/r\/issues -f title=gantry: the daily secret scan failed -f body=gitleaks found a key/);
  assert.match(r.calls, /Run: https:\/\/run\/1/);
  assert.match(r.calls, /Revoke the key/);
  assert.doesNotMatch(r.calls, /\/comments/);
});

test("alert: an open issue gets a comment, not a second issue", () => {
  const r = alert({ existing: "7", result: "leaks" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /repos\/o\/r\/issues\/7\/comments -f body=/);
  assert.doesNotMatch(r.calls, /-f title=/);
});

test("alert: a scan that errored says so instead of claiming a leak", () => {
  const r = alert({ result: "error" });
  assert.match(r.calls, /did not finish/);
  assert.doesNotMatch(r.calls, /found a key/);
});

test("alert: only the alert job can write issues, and it never checks out code", () => {
  const yml = readFileSync(DAILY, "utf8");
  const scanJob = yml.slice(yml.indexOf("\n  scan:"), yml.indexOf("\n  alert:"));
  const alertJob = yml.slice(yml.indexOf("\n  alert:"));
  assert.match(yml, /^permissions:\n  contents: read\n\n/m);
  assert.match(scanJob, /permissions:\n      contents: read\n    outputs/);
  assert.match(alertJob, /permissions:\n      issues: write\n    steps/);
  assert.doesNotMatch(alertJob, /actions\/checkout|gitleaks detect/);
  assert.match(alertJob, /if: \$\{\{ failure\(\) \}\}/);
});
