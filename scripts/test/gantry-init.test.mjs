import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INIT = join(dirname(fileURLToPath(import.meta.url)), "../../bin/gantry-init");
const WORKFLOW = ".github/workflows/ac-check.yml";
const PR_TEMPLATE = ".github/pull_request_template.md";

// A .husky dir makes gantry-init stop before installing lefthook, so these
// tests don't need lefthook and leave no hooks behind.
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-init-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, ".husky"));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const init = (dir, ...flags) => execFileSync(INIT, [dir, ...flags], { encoding: "utf8" });
const read = (dir, path) => readFileSync(join(dir, path), "utf8");
function put(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

test("no flag: no workflow, and the template has no acceptance criteria", () =>
  withRepo((dir) => {
    init(dir);
    assert.equal(existsSync(join(dir, WORKFLOW)), false);
    const template = read(dir, PR_TEMPLATE);
    assert.doesNotMatch(template, /acceptance criteria/i);
    assert.match(template, /^Closes #/m);
    assert.match(template, /^## How I verified/m);
  }));

test("--ac-check: adds the workflow, and the template has the section", () =>
  withRepo((dir) => {
    init(dir, "--ac-check");
    assert.ok(existsSync(join(dir, WORKFLOW)));
    const template = read(dir, PR_TEMPLATE);
    assert.match(template, /^## Acceptance criteria/m);
    assert.match(template, /^Closes #/m);
    assert.match(template, /^## How I verified/m);
  }));

test("re-run with no flag keeps an existing workflow unchanged", () =>
  withRepo((dir) => {
    put(dir, WORKFLOW, "# customised\n");
    const out = init(dir);
    assert.equal(read(dir, WORKFLOW), "# customised\n");
    assert.match(out, /keep\s+\.github\/workflows\/ac-check\.yml/);
  }));

test("existing workflow with no template: the new template has the section it needs", () =>
  withRepo((dir) => {
    put(dir, WORKFLOW, "# customised\n");
    init(dir);
    assert.match(read(dir, PR_TEMPLATE), /^## Acceptance criteria/m);
  }));

test("--ac-check keeps an existing template and warns that it lacks the section", () =>
  withRepo((dir) => {
    put(dir, PR_TEMPLATE, "Closes #\n");
    const out = init(dir, "--ac-check");
    assert.equal(read(dir, PR_TEMPLATE), "Closes #\n");
    assert.match(out, /! .*pull_request_template\.md.*Acceptance criteria/);
  }));

test("--ac-check warns about a heading ac-check can't read", () =>
  withRepo((dir) => {
    put(dir, PR_TEMPLATE, "## Acceptance criteria for this PR\n");
    assert.match(init(dir, "--ac-check"), /! .*pull_request_template\.md.*Acceptance criteria/);
  }));

test("--ac-check stays quiet when the existing template has the section", () =>
  withRepo((dir) => {
    put(dir, PR_TEMPLATE, "## Acceptance criteria\n");
    assert.doesNotMatch(init(dir, "--ac-check"), /! .*pull_request_template/);
  }));
