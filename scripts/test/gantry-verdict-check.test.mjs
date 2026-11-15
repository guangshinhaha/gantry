// bin/gantry-verdict-check end to end against a fake gh on PATH: the command the
// factory runs before a merge. Never calls the real gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, parseArgs } from "../verdict-check.mjs";

const CMD = join(dirname(fileURLToPath(import.meta.url)), "../../bin/gantry-verdict-check");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

let id = 0;
const comment = (verdict, head_sha = HEAD, { at, assoc = "OWNER" } = {}) => {
  id++;
  return {
    id,
    created_at: at ?? `2026-11-15T00:00:${String(id).padStart(2, "0")}Z`,
    author_association: assoc,
    body: "Verified.\n```json\n" + JSON.stringify({ pr: 7, head_sha, verdict, evidence: ["node --test: ok"] }) + "\n```",
  };
};

// Runs the command with a fake gh that serves `pull` and `comments` (as one
// --slurp page) and logs every call. `failGh` makes every gh call exit 1.
// `via`: "repo-link" runs it through a symlink to the gantry checkout,
// "bin-link" through a symlink to the command itself (as on PATH).
function check(args, { pull = { head: { sha: HEAD }, labels: [] }, comments = [], failGh = false, env = {}, via } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-verdict-check-test-"));
  try {
    writeFileSync(join(dir, "pull.json"), JSON.stringify(pull));
    writeFileSync(join(dir, "comments.json"), JSON.stringify([comments]));
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh
echo "$*" >> "${dir}/calls"
${failGh ? 'echo "gh: HTTP 502" >&2; exit 1' : ""}
case "$*" in
  "repo view"*) echo o/r ;;
  *"/pulls/"*) cat "${dir}/pull.json" ;;
  *"/comments"*) cat "${dir}/comments.json" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 9 ;;
esac
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    let cmd = CMD;
    if (via === "repo-link") {
      symlinkSync(join(dirname(CMD), ".."), join(dir, "gantry"));
      cmd = join(dir, "gantry/bin/gantry-verdict-check");
    } else if (via === "bin-link") {
      symlinkSync(CMD, join(dir, "gantry-verdict-check"));
      cmd = join(dir, "gantry-verdict-check");
    }
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, ...env },
    });
    let calls = [];
    try { calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { /* no calls */ }
    return { ...r, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL = ["--repo", "o/r", "--pr", "7", "--no-label"];

test("PASS at the head passes", () => {
  const r = check(ALL, { comments: [comment("PASS")] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS: PASS verdict at head aaaaaaa/);
  assert.ok(r.calls.includes("api repos/o/r/pulls/7"), r.calls.join("\n"));
});

test("PASS+NOTES at the head passes", () => {
  assert.equal(check(ALL, { comments: [comment("PASS+NOTES")] }).status, 0);
});

test("a verdict at a stale sha fails, naming the head", () => {
  const r = check(ALL, { comments: [comment("PASS", OLD)] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL: No verdict for head aaaaaaa/);
  assert.doesNotMatch(r.stdout, /::error::/, "no Actions annotation outside Actions");
});

test("FAIL at the head fails", () => {
  const r = check(ALL, { comments: [comment("FAIL")] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL: Latest verdict at head aaaaaaa is FAIL/);
});

test("the latest verdict at the head wins", () => {
  const pass = comment("PASS", HEAD, { at: "2026-11-15T01:00:00Z" });
  const fail = comment("FAIL", HEAD, { at: "2026-11-15T02:00:00Z" });
  assert.equal(check(ALL, { comments: [pass, fail] }).status, 1);
  const repass = comment("PASS", HEAD, { at: "2026-11-15T03:00:00Z" });
  assert.equal(check(ALL, { comments: [pass, fail, repass] }).status, 0);
});

test("an untrusted author's PASS does not count", () => {
  assert.equal(check(ALL, { comments: [comment("PASS", HEAD, { assoc: "NONE" })] }).status, 1);
});

test("without --no-label an unlabelled PR skips; with the label it is checked", () => {
  const args = ["--repo", "o/r", "--pr", "7"];
  const skip = check(args, { comments: [] });
  assert.equal(skip.status, 0);
  assert.match(skip.stdout, /^SKIP:/);
  const labelled = { head: { sha: HEAD }, labels: [{ name: "risk:high" }] };
  assert.equal(check(args, { pull: labelled }).status, 1);
  assert.equal(check([...args, "--label", "tier:high"], { pull: labelled }).status, 0);
});

test("without --repo it asks gh for the current repo", () => {
  const r = check(["--pr", "7", "--no-label"], { comments: [comment("PASS")] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0], "repo view --json nameWithOwner --jq .nameWithOwner");
});

test("gh failing exits 2 with the reason, never a pass", () => {
  const r = check(ALL, { failGh: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not read PR 7 from GitHub/);
  assert.equal(r.stdout, "");
});

test("bad arguments exit 2 before calling gh", () => {
  for (const args of [[], ["--pr"], ["--pr", "x"], ["--pr", "0"], ["--pr", "7", "--bogus"], ["--pr", "7", "--repo", "noslash"]]) {
    const r = check(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.calls, [], args.join(" "));
  }
});

test("inside Actions a FAIL is an error annotation, as in the workflow", () => {
  const r = check(ALL, { comments: [], env: { GITHUB_ACTIONS: "true" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::No verdict for head/);
});

test("parseArgs: the workflow's env only when there are no flags", () => {
  const env = { REPO: "e/r", PR: "3", LABEL: "bug", TRUSTED: "OWNER" };
  assert.deepEqual(parseArgs([], env), { repo: "e/r", pr: 3, label: "bug", trusted: ["OWNER"] });
  assert.deepEqual(parseArgs(["--repo", "o/r", "--pr", "7", "--no-label", "--trusted", "OWNER, MEMBER"], env), {
    repo: "o/r", pr: 7, label: null, trusted: ["OWNER", "MEMBER"],
  });
  assert.deepEqual(parseArgs(["--pr", "7"], env), {
    repo: "", pr: 7, label: "risk:high", trusted: ["OWNER", "MEMBER", "COLLABORATOR"],
  });
  assert.equal(parseArgs([], { PR: "7", LABEL: "" }).label, "risk:high");
});

test("the command ignores REPO, PR, LABEL and TRUSTED in its env", () => {
  const env = { REPO: "other/repo", PR: "7", LABEL: "bug", TRUSTED: "NONE" };
  const r = check(["--pr", "7", "--no-label"], { comments: [comment("PASS", HEAD, { assoc: "NONE" })], env });
  assert.equal(r.status, 1, "NONE is not trusted by default");
  assert.equal(r.calls[0], "repo view --json nameWithOwner --jq .nameWithOwner");
  assert.ok(r.calls.includes("api repos/o/r/pulls/7"), r.calls.join("\n"));
  const noPr = check([], { env, comments: [comment("PASS")] });
  assert.equal(noPr.status, 2, "PR in the env is not --pr");
  assert.deepEqual(noPr.calls, []);
  const labelled = { head: { sha: HEAD }, labels: [{ name: "risk:high" }] };
  assert.equal(check(["--pr", "7"], { pull: labelled, env }).status, 1, "LABEL=bug must not turn risk:high into a skip");
});

test("through a symlinked checkout or a symlink on PATH it still runs the check", () => {
  for (const via of ["repo-link", "bin-link"]) {
    const fail = check(ALL, { via, comments: [comment("PASS", OLD)] });
    assert.equal(fail.status, 1, `${via}: ${fail.stdout}${fail.stderr}`);
    assert.match(fail.stdout, /^FAIL:/);
    const bad = check(["--pr", "abc"], { via });
    assert.equal(bad.status, 2, `${via}: ${bad.stdout}${bad.stderr}`);
    assert.equal(check(ALL, { via, comments: [comment("PASS")] }).status, 0, via);
  }
});

test("node on the script through a symlinked path still runs main", () => {
  const dir = mkdtempSync(join(tmpdir(), "gantry-verdict-check-link-"));
  try {
    symlinkSync(join(dirname(CMD), ".."), join(dir, "gantry"));
    const r = spawnSync("node", [join(dir, "gantry/scripts/verdict-check.mjs"), "--pr", "abc"], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--pr <number> is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluate with label null never skips", () => {
  const r = evaluate({ prNumber: 7, headSha: HEAD, labels: [], label: null, comments: [] });
  assert.equal(r.status, "fail");
});
