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

// Stub gh: PR files are code, root package.json is present (200), missing
// (404) or errors (500), and the recursive tree comes from `tree` (or fails).
const GH = `#!/bin/bash
case "$*" in
  *"/pulls/"*"/files"*) echo "src/x.ts" ;;
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
  *" ls-tree "*) printf '%s\\n' "$STUB_GIT_PATHS" | tr '\\n' '\\0' ;;
  *) echo "stub git: unexpected $*" >&2; exit 2 ;;
esac
`;

function runGate({ root, tree = [], truncated = false, treeFails = false, treeBody = "", gitPaths = null, node = "true" }) {
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
        REPO: "o/r", EVENT: "pull_request", PR: "1", SHA: "abc", BEFORE: "",
        NODE_INPUT: node, STUB_ROOT: String(root), STUB_TREE: treeFails ? "fail" : treeFile, STUB_TREE_BODY: treeBody, STUB_GIT_PATHS: gitPaths ?? "fail",
        RUNNER_TEMP: dir, GITHUB_SERVER_URL: "https://github.com", GH_TOKEN: "t",
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

test("a file that only ends in package.json doesn't count", () => {
  const r = runGate({ root: 404, tree: ["notpackage.json", "docs/my-package.json"] });
  assert.equal(r.outputs.run_node, "false");
  assert.equal(r.outputs.node_error ?? "", "");
});

// A truncated tree falls back to a blobless shallow fetch, stubbed here: `git
// ls-tree` prints STUB_GIT_PATHS (newline-separated), or the fetch fails.
for (const [name, paths, expect] of [
  ["no package.json anywhere: skips, as before", "a.md\nsrc/x.go", "skip"],
  ["nested package.json: node fails", "a.md\nweb/package.json", "fail"],
  ["fetch fails: gate fails", null, "gate"],
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
    else assert.match(r.outputs.node_error, /web\/package\.json.*node: false/);
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
