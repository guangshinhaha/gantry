import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GLOBS, highRisk } from "../high-risk-paths.mjs";

const files = (...f) => highRisk(f).map((h) => h.file);

test("defaults catch workflows, the template's .github and gantry-protect", () => {
  assert.deepEqual(files(".github/workflows/ci.yml", "template/.github/pull_request_template.md", "bin/gantry-protect"),
    [".github/workflows/ci.yml", "template/.github/pull_request_template.md", "bin/gantry-protect"]);
});

test("a docs-only change matches nothing", () => {
  assert.deepEqual(files("README.md", "docs/decisions/0001.md", "scripts/risky-paths.mjs", "bin/gantry-init"), []);
});

test("defaults are anchored to the repo root", () => {
  assert.deepEqual(files("vendor/.github/workflows/x.yml", "other/bin/gantry-protect"), []);
});

test("a repo's own globs add to the defaults, they don't replace them", () => {
  const extra = "# shinfactory\nloop/**\ndispatcher/**\n\nconfig/**\n";
  assert.deepEqual(highRisk(["loop/a/b.go", "dispatcher/x.go", "config/y.yml", ".github/workflows/z.yml", "docs/a.md"], extra).map((h) => h.file),
    ["loop/a/b.go", "dispatcher/x.go", "config/y.yml", ".github/workflows/z.yml"]);
});

test("a repo list with no entries leaves just the defaults", () => {
  assert.deepEqual(files("loop/a.go"), []);
  assert.deepEqual(highRisk(["loop/a.go"], "# nothing yet\n").length, 0);
  assert.equal(DEFAULT_GLOBS.length, 3);
});

test("CLI: prints the matches, nothing for a clean change; the list file may be absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "hrp-"));
  const changed = join(dir, "changed.txt");
  const script = new URL("../high-risk-paths.mjs", import.meta.url).pathname;
  writeFileSync(changed, ".github/workflows/ci.yml\nREADME.md\n");
  const out = execFileSync("node", [script, join(dir, "no-such-list"), changed], { encoding: "utf8" });
  assert.match(out, /^- `\.github\/workflows\/ci\.yml` \(`\.github\/workflows\/\*\*`\)$/m);
  assert.doesNotMatch(out, /README/);
  writeFileSync(changed, "README.md\n");
  assert.equal(execFileSync("node", [script, join(dir, "no-such-list"), changed], { encoding: "utf8" }), "");
});

test("gantry's own list marks the factory config, skills and backlog adapter High", () => {
  const list = readFileSync(new URL("../../.github/gantry-high-risk-paths", import.meta.url), "utf8");
  const hits = highRisk([".noodle.toml", ".agents/skills/execute/SKILL.md", "adapters/github/backlog.sh", "README.md"], list).map((h) => h.file);
  assert.deepEqual(hits, [".noodle.toml", ".agents/skills/execute/SKILL.md", "adapters/github/backlog.sh"]);
});
