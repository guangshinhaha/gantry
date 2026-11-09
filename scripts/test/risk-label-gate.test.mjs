// Runs the real shell of risk-label.yml's two run steps with a fake `gh` and `curl`
// on PATH (never the real gh or network), and checks what it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPTS = new URL("../", import.meta.url).pathname;
const wf = readFileSync(new URL("../../.github/workflows/risk-label.yml", import.meta.url), "utf8");
const step = (name) => {
  const after = wf.split(`- name: ${name}\n`)[1];
  const run = after.split(/^ {8}run: \|\n/m)[1];
  return run.split(/^ {6}\S/m)[0].replace(/^ {10}/gm, "");
};
const GATE = step("Decide whether to run");
const LABEL = step("Add the label if a High-risk path changed");
const SHA = "a".repeat(40);

function run(body, env, { files = [], ghFails = false, existing = [], labelCreate = "ok" } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "risk-gate-"));
  const bin = join(dir, "bin");
  const sh = (name, text) => { writeFileSync(join(dir, name), text); chmodSync(join(dir, name), 0o755); };
  // The label step writes /tmp/*.mjs and /tmp/*.md; point those at this run's dir.
  const script = body.replaceAll("/tmp/", `${dir}/`);
  writeFileSync(join(dir, "files.json"), JSON.stringify(files.map((f) => (typeof f === "string" ? { filename: f } : f))));
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "gh"), `#!/bin/bash
echo "$*" >> "${dir}/gh.log"
case "$1 $2" in
  "api repos/o/r/pulls/7/files") while [ $# -gt 0 ]; do [ "$1" = --jq ] && expr="$2"; shift; done; jq -r "$expr" "${dir}/files.json" ;;
  "api -X") ${ghFails ? "exit 1" : "exit 0"} ;;
  "api repos/o/r/issues/7/labels") printf '%s\\n' ${existing.map((l) => `'${l}'`).join(" ")} ;;
  "label create") ${labelCreate === "exists" ? 'echo "label already exists" >&2; exit 1' : labelCreate === "denied" ? 'echo "HTTP 403: Resource not accessible" >&2; exit 1' : "exit 0"} ;;
esac
`);
  writeFileSync(join(bin, "curl"), `#!/bin/bash
echo "$*" >> "${dir}/curl.log"
while [ $# -gt 0 ]; do case "$1" in -o) out="$2";; esac; shift; done
cp "${SCRIPTS}$(basename "$out")" "$out"
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(dir, "summary"), "");
  writeFileSync(join(dir, "output"), "");
  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: join(dir, "summary"), GITHUB_OUTPUT: join(dir, "output"),
      REPO: "o/r", PR: "7", LABEL: "risk:high", GANTRY_REF: SHA, ...env },
    encoding: "utf8",
  });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { ...r, gh: read("gh.log"), curl: read("curl.log"), output: read("output") };
}

test("gate: not a pull request means skip", () => {
  const r = run(GATE, { PR_NUMBER: "", HEAD_REPO: "o/r" });
  assert.equal(r.status, 0);
  assert.match(r.output, /run=false/);
});
test("gate: same-repo PR runs, fork PR is flagged read-only", () => {
  assert.doesNotMatch(run(GATE, { PR_NUMBER: "7", HEAD_REPO: "o/r", ACTOR: "shin" }).output, /readonly=true/);
  const fork = run(GATE, { PR_NUMBER: "7", HEAD_REPO: "x/r", ACTOR: "shin" });
  assert.match(fork.output, /run=true/);
  assert.match(fork.output, /readonly=true/);
});
test("gate: a Dependabot PR on a same-repo branch is read-only too", () => {
  const r = run(GATE, { PR_NUMBER: "7", HEAD_REPO: "o/r", ACTOR: "dependabot[bot]" });
  assert.match(r.output, /run=true/);
  assert.match(r.output, /readonly=true/);
});
test("gate: removing the label by hand does not re-run the labelling", () => {
  const r = run(GATE, { PR_NUMBER: "7", HEAD_REPO: "o/r", EVENT_ACTION: "unlabeled", EVENT_LABEL: "risk:high", LABEL: "risk:high" });
  assert.match(r.output, /run=false/);
  assert.doesNotMatch(r.output, /run=true/);
});
test("gate: removing some other label, or any other event, still runs", () => {
  assert.match(run(GATE, { PR_NUMBER: "7", HEAD_REPO: "o/r", EVENT_ACTION: "unlabeled", EVENT_LABEL: "bug", LABEL: "risk:high" }).output, /run=true/);
  assert.match(run(GATE, { PR_NUMBER: "7", HEAD_REPO: "o/r", EVENT_ACTION: "labeled", EVENT_LABEL: "risk:high", LABEL: "risk:high" }).output, /run=true/);
});

test("label: a High-risk file gets the label", () => {
  const r = run(LABEL, {}, { files: ["README.md", ".github/workflows/ci.yml"] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.gh, /api -X POST repos\/o\/r\/issues\/7\/labels -f labels\[\]=risk:high/);
  assert.doesNotMatch(r.gh, /pr edit/);
});
test("label: an unrelated PR gets no label", () => {
  const r = run(LABEL, {}, { files: ["README.md", "src/a.js"] });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.gh, /-X POST/);
});
test("label: a High-risk file renamed away is still caught by its old name", () => {
  const r = run(LABEL, {}, { files: [{ filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml" }] });
  assert.match(r.gh, /-X POST/);
});
test("label: 3000+ files are labelled even with nothing matching", () => {
  const files = Array.from({ length: 3000 }, (_, i) => `src/f${i}.js`);
  assert.match(run(LABEL, {}, { files }).gh, /-X POST/);
});
test("label: a fork PR touching a High-risk path fails and adds nothing", () => {
  const r = run(LABEL, { READONLY: "true" }, { files: [".github/workflows/ci.yml"] });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.gh, /-X POST/);
});
test("label: a read-only PR that a maintainer already labelled passes", () => {
  const r = run(LABEL, { READONLY: "true" }, { files: [".github/workflows/ci.yml"], existing: ["bug", "risk:high"] });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.gh, /-X POST/);
});
test("label: a read-only PR with only a lookalike label still fails", () => {
  const r = run(LABEL, { READONLY: "true" }, { files: [".github/workflows/ci.yml"], existing: ["risk:higher", "not-risk:high"] });
  assert.notEqual(r.status, 0);
});
test("label: a fork PR touching nothing risky passes", () => {
  assert.equal(run(LABEL, { READONLY: "true" }, { files: ["README.md"] }).status, 0);
});
test("label: a failed gh edit fails the job", () => {
  assert.notEqual(run(LABEL, {}, { files: [".github/workflows/ci.yml"], ghFails: true }).status, 0);
});
test("label: renames' old names don't count toward the 3000-file cap", () => {
  const files = Array.from({ length: 1600 }, (_, i) => ({ filename: `src/n${i}.js`, previous_filename: `src/o${i}.js` }));
  const r = run(LABEL, {}, { files });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.gh, /-X POST/);
});
test("label: 'label already exists' is fine, any other label-create error fails the job", () => {
  const f = { files: [".github/workflows/ci.yml"] };
  const ok = run(LABEL, {}, { ...f, labelCreate: "exists" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.gh, /-X POST/);
  const bad = run(LABEL, {}, { ...f, labelCreate: "denied" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /403/);
  assert.doesNotMatch(bad.gh, /-X POST/);
});
test("label: scripts are downloaded at the given sha, from nowhere else", () => {
  const r = run(LABEL, {}, { files: ["README.md"] });
  const urls = r.curl.match(/https:\/\/\S+/g);
  assert.equal(urls.length, 2);
  for (const u of urls) assert.ok(u.includes(`/gantry/${SHA}/scripts/`), u);
});
test("label: a branch or tag name as gantry-ref is refused before anything is downloaded", () => {
  for (const ref of ["main", "v1", "abc1234", `${SHA}x`, ""]) {
    const r = run(LABEL, { GANTRY_REF: ref }, { files: [".github/workflows/ci.yml"] });
    assert.notEqual(r.status, 0, ref);
    assert.equal(r.curl, "", ref);
    assert.doesNotMatch(r.gh, /-X POST/, ref);
  }
});

test("the default gantry-ref is a full commit sha, not a moving ref", () => {
  assert.match(wf, /gantry-ref:\n(?:\s+description:.*\n)\s+type: string\n\s+default: [0-9a-f]{40}\n/);
});
test("gantry's own caller labels with the PR's base scripts, not its head", () => {
  const own = readFileSync(new URL("../../.github/workflows/verdict-check-caller.yml", import.meta.url), "utf8");
  assert.match(own, /gantry-ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(own, /head\.sha/);
});
