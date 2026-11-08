// Runs the gate step of ci.yml (the `id: check` script) against a stub `gh`,
// to pin down when the node job runs, skips or fails (gantry#35, gantry#66).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CI = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

// The `run: |` block of the step with `id: check`, de-indented.
function gateScript() {
  const lines = readFileSync(CI, "utf8").split("\n");
  const step = lines.findIndex((l) => /^\s*- id: check\s*$/.test(l));
  const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  assert.ok(step >= 0 && run > step, "gate step not found in ci.yml");
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

// Stub gh: API bodies come from env (STUB_FILES, STUB_PR, STUB_COMPARE) and go
// through the real jq with the caller's --jq filter, so the filters are tested
// too. Root package.json is present (200), missing (404) or errors (500), and
// the recursive tree comes from `tree` (or fails).
const GH = `#!/bin/bash
filter() { while [ $# -gt 0 ]; do [ "$1" = --jq ] && { printf '%s' "$2"; return; }; shift; done; }
case "$*" in
  *"/pulls/"*"/files"*) printf '%s' "$STUB_FILES" | jq -r "$(filter "$@")" ;;
  *"/pulls/"*) printf '%s' "$STUB_PR" | jq -r "$(filter "$@")" ;;
  *"/compare/"*) [ "$STUB_COMPARE" = fail ] && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }; printf '%s' "$STUB_COMPARE" | jq -r "$(filter "$@")" ;;
  *"/commits/"*"/pulls"*) printf '%s' "$STUB_MERGED" | jq -r "$(filter "$@")" ;;
  *"/contents/package.json"*)
    case "$STUB_ROOT" in
      200) exit 0 ;;
      404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      *) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;
    esac ;;
  *"/git/trees/"*"recursive=1"*)
    [ "$STUB_TREE" = fail ] && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    [ -n "$STUB_TREE_BODY" ] && { printf '%s' "$STUB_TREE_BODY"; exit 0; }
    cat "$STUB_TREE" ;;
  *) echo "stub gh: unexpected $*" >&2; exit 2 ;;
esac
`;
const GIT = `#!/bin/bash
case "$*" in
  *" init "*|init*) mkdir -p "\${@: -1}" ;;
  *" fetch "*) [ "$STUB_GIT_PATHS" = fail ] && { echo "fatal: stub" >&2; exit 128; }; exit 0 ;;
  *" ls-tree "*) printf '%s\\n' "$STUB_GIT_PATHS" ;;
  *) echo "stub git: unexpected $*" >&2; exit 2 ;;
esac
`;

// files: names, or {filename, previous_filename} for a rename. changed: the
// PR's changed_files count (defaults to the number listed). compare: what the
// push path's compare API lists ("fail" = the call errors).
function runGate({
  root, tree = [], truncated = false, treeFails = false, treeBody = "", gitPaths = null, node = "true",
  files = ["src/x.ts"], changed = files.length, event = "pull_request", compare = [], merged = [],
}) {
  const entry = (f) => (typeof f === "string" ? { filename: f } : f);
  const dir = mkdtempSync(join(tmpdir(), "gantry-gate-"));
  writeFileSync(join(dir, "gh"), GH);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "git"), GIT);
  chmodSync(join(dir, "git"), 0o755);
  const treeFile = join(dir, "tree.json");
  writeFileSync(
    treeFile,
    JSON.stringify({ truncated, tree: tree.map((path) => ({ path, type: path.endsWith("/") ? "tree" : "blob" })) }),
  );
  const out = join(dir, "out"), summary = join(dir, "summary");
  writeFileSync(out, ""); writeFileSync(summary, "");
  let status = 0, log = "";
  try {
    log = execFileSync("bash", ["-e", "-c", gateScript()], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary,
        REPO: "o/r", EVENT: event, PR: "1", SHA: "abc", BEFORE: event === "push" ? "def" : "",
        STUB_FILES: JSON.stringify(files.map(entry)), STUB_PR: JSON.stringify({ changed_files: changed }),
        STUB_COMPARE: compare === "fail" ? "fail" : JSON.stringify({ files: compare.map(entry) }), STUB_MERGED: JSON.stringify(merged),
        NODE_INPUT: node, STUB_ROOT: String(root), STUB_TREE: treeFails ? "fail" : treeFile, STUB_TREE_BODY: treeBody, STUB_GIT_PATHS: gitPaths ?? "fail",
        LANG: "C.UTF-8", RUNNER_TEMP: dir, GITHUB_SERVER_URL: "https://github.com", GH_TOKEN: "t",
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status; log = e.stdout + e.stderr;
  }
  const outputs = {};
  // Multi-line outputs use the name<<DELIM form.
  const text = readFileSync(out, "utf8");
  for (const m of text.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  for (const m of text.matchAll(/^(\w+)=(.*)$/gm)) outputs[m[1]] = m[2];
  return { status, log, outputs, summary: readFileSync(summary, "utf8") };
}

test("root package.json: node runs", () => {
  const r = runGate({ root: 200 });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.run_node, "true");
  assert.equal(r.outputs.node_error ?? "", "");
});

test("no package.json anywhere: node skips, as before", () => {
  const r = runGate({ root: 404, tree: ["README.md", "docs/", "docs/a.md"] });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.run_node, "false");
  assert.equal(r.outputs.node_error ?? "", "");
  assert.match(r.summary, /Node checks skipped: no package.json in this repo/);
});

test("node: false wins over a nested package.json", () => {
  const r = runGate({ root: 404, tree: ["app/", "app/package.json"], node: "false" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.run_node, "false");
  assert.equal(r.outputs.node_error ?? "", "");
});

test("nested package.json only: node is set to fail with a message naming node: false", () => {
  const r = runGate({ root: 404, tree: ["app/", "app/package.json", "app/src/quota.ts", "README.md"] });
  assert.equal(r.status, 0, r.log); // the gate passes, so the secret scan still runs
  assert.equal(r.outputs.run_node, "false");
  assert.match(r.outputs.node_error, /app\/package\.json/);
  assert.match(r.outputs.node_error, /node: false/);
  assert.match(r.outputs.node_error, /root/);
});

test("a name with a newline before package.json doesn't count", () => {
  const r = runGate({ root: 404, tree: ["notes\npackage.json"] });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.node_error ?? "", "");
  assert.equal(r.outputs.run_node, "false");
});

test("a name with a newline after package.json doesn't count", () => {
  const r = runGate({ root: 404, tree: ["notes/package.json\n"] });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.node_error ?? "", "");
});

test("a file that only ends in package.json doesn't count", () => {
  const r = runGate({ root: 404, tree: ["notpackage.json", "docs/my-package.json"] });
  assert.equal(r.outputs.run_node, "false");
  assert.equal(r.outputs.node_error ?? "", "");
});

// A truncated tree falls back to a blobless shallow fetch, stubbed here: `git
// ls-tree` prints STUB_GIT_PATHS as git would (one per line, odd names
// quoted and escaped), or the fetch fails.
for (const [name, paths, expect] of [
  ["no package.json anywhere: skips, as before", "a.md\nsrc/x.go", "skip"],
  ["nested package.json: node fails", "a.md\nweb/package.json", "fail"],
  ["fetch fails: gate fails", null, "gate"],
  ["a name with a newline doesn't count", '"notes\\npackage.json"', "skip"],
  ["a quoted nested name still counts", '"w\\303\\251b \\"x\\"/package.json"', "fail-quoted"],
  ["a non-UTF-8 nested name still counts", '"caf\\351/package.json"', "fail-quoted"],
]) {
  test(`truncated tree, ${name}`, () => {
    const r = runGate({ root: 404, tree: ["a.md"], truncated: true, gitPaths: paths });
    if (expect === "gate") {
      assert.notEqual(r.status, 0, r.log);
      assert.match(r.log, /could not list/);
      return;
    }
    assert.equal(r.status, 0, r.log);
    assert.equal(r.outputs.run_node, "false");
    if (expect === "skip") assert.equal(r.outputs.node_error ?? "", "");
    else if (expect === "fail") assert.match(r.outputs.node_error, /web\/package\.json.*node: false/);
    else assert.match(r.outputs.node_error, /package\.json".*node: false/);
  });
}

test("tree API error fails the gate, like a contents API error", () => {
  const r = runGate({ root: 404, treeFails: true });
  assert.notEqual(r.status, 0);
  assert.match(r.log, /could not list/);
});

for (const [name, treeBody] of [["null tree", '{"tree":null,"truncated":false}'], ["HTML", "<html>oops</html>"], ["empty", " "]]) {
  test(`unreadable tree body (${name}) fails the gate instead of skipping`, () => {
    const r = runGate({ root: 404, treeBody });
    assert.notEqual(r.status, 0, r.log);
    assert.match(r.log, /could not list/);
  });
}

test("contents API error still fails the gate", () => {
  const r = runGate({ root: 500 });
  assert.notEqual(r.status, 0);
  assert.match(r.log, /could not check for package.json/);
});

// The script tests above don't cover the wiring that turns ci-ok red: the gate
// must export node_error, and the node job must run on it and fail first.
test("ci.yml wires node_error from the gate to a failing first node step", () => {
  const yml = readFileSync(CI, "utf8");
  assert.match(yml, /^\s+node_error: \$\{\{ steps\.check\.outputs\.node_error \}\}$/m);
  const node = yml.slice(yml.indexOf("\n  node:\n"), yml.indexOf("\n  ci-ok:\n"));
  assert.match(node, /^\s+if: .*needs\.gate\.outputs\.run_node == 'true' \|\| needs\.gate\.outputs\.node_error != ''/m);
  const first = node.slice(node.indexOf("steps:"), node.indexOf("- uses: actions/checkout"));
  assert.match(first, /if: \$\{\{ needs\.gate\.outputs\.node_error != '' \}\}/);
  assert.match(first, /NODE_ERROR: \$\{\{ needs\.gate\.outputs\.node_error \}\}/);
  assert.match(first, /exit 1/);
  assert.match(yml, /ci-ok:\n\s+needs: \[gate, secrets, node\]/);
});

// Docs-only gate (gantry#59, #60, #61, #62). Each case says whether the change
// counts as docs-only, which lets the node job off.
const run = (o) => runGate({ root: 200, ...o }).outputs.run_node;

for (const [name, files, docsOnly] of [
  ["docs and markdown", ["docs/a.md", "README.md", "src/prompt.md"], true],
  ["an image under docs/", ["docs/diagram.png", "docs/a.md"], true],
  ["code", ["src/x.ts"], false],
  // gantry#59: a rename lists the new name, so the old one must count too.
  ["rename of code to .md", [{ filename: "src/quota.md", previous_filename: "src/quota.ts", status: "renamed" }], false],
  ["rename of code into docs/", [{ filename: "docs/quota.ts", previous_filename: "src/quota.ts", status: "renamed" }], false],
  ["rename of package.json to .md", [{ filename: "package.md", previous_filename: "package.json", status: "renamed" }], false],
  ["rename of a .md into code", [{ filename: "src/a.ts", previous_filename: "notes.md", status: "renamed" }], false],
  ["rename within docs", [{ filename: "docs/b.md", previous_filename: "docs/a.md", status: "renamed" }], true],
  // gantry#60 option A: code file types count as code wherever they sit.
  ["code file under docs/", ["docs/limit.ts"], false],
  ["code file under docs/ next to docs", ["docs/a.md", "docs/limit.ts"], false],
  ["upper-case extension under docs/", ["docs/LIMIT.TS"], false],
  ["nested docs/ path", ["docs/deep/er/limit.mjs"], false],
  ["package.json under docs/", ["docs/package.json"], false],
  ["yaml under docs/", ["docs/ci.yml"], false],
  ["a .md name that ends in a code extension is still .md", ["docs/limit.ts.md"], true],
]) {
  test(`gate, PR: ${name} ${docsOnly ? "is docs-only" : "runs node"}`, () => {
    assert.equal(run({ files }), docsOnly ? "false" : "true");
  });
}

// gantry#61: the files API stops at 3000, so a shorter list than changed_files
// means the rest are unseen.
test("gate, PR: a list shorter than changed_files is not docs-only", () => {
  assert.equal(run({ files: ["docs/a.md"], changed: 3001 }), "true");
});
test("gate, PR: a list as long as changed_files is docs-only", () => {
  assert.equal(run({ files: ["docs/a.md", "docs/b.md"], changed: 2 }), "false");
});
test("gate, PR: renames don't throw the count off", () => {
  const files = [{ filename: "docs/b.md", previous_filename: "docs/a.md", status: "renamed" }, "docs/c.md"];
  assert.equal(run({ files, changed: 2 }), "false");
});

// gantry#62: compare lists at most 300 files, so 300 may be a cut-off list.
const docs = (n) => Array.from({ length: n }, (_, i) => `docs/many/f${i}.md`);
const push = (compare) => run({ event: "push", compare });
test("gate, push: 299 docs files are docs-only", () => assert.equal(push(docs(299)), "false"));
test("gate, push: 300 docs files may hide code, so node runs", () => assert.equal(push(docs(300)), "true"));
test("gate, push: code in the list runs node", () => assert.equal(push(["docs/a.md", "src/x.ts"]), "true"));
test("gate, push: a rename of code to .md runs node", () => {
  assert.equal(push([{ filename: "src/quota.md", previous_filename: "src/quota.ts", status: "renamed" }]), "true");
});
test("gate, push: a code file under docs/ runs node", () => assert.equal(push(["docs/limit.ts"]), "true"));
test("gate, push: a failed compare is not docs-only", () => assert.equal(push("fail"), "true"));
test("gate, push: an empty list is not docs-only", () => assert.equal(push([]), "true"));
