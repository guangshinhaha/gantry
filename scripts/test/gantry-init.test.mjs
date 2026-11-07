import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// A stand-in formatter: records the arguments it got, one per line.
function installFormatter(dir, name, exitCode = 0) {
  put(dir, `node_modules/.bin/${name}`, `#!/bin/sh\nprintf '%s\\n' "$@" > ${name}.args\nexit ${exitCode}\n`);
  chmodSync(join(dir, `node_modules/.bin/${name}`), 0o755);
}
const argsOf = (dir, name) => read(dir, `${name}.args`).trim().split("\n");
const pkg = (fields) => JSON.stringify({ name: "x", private: true, ...fields });
const OXFMT_REPO = pkg({ scripts: { "format:check": "oxfmt --check ." }, devDependencies: { oxfmt: "1.0.0" } });

test("formats only the files it added, with the repo's formatter", () =>
  withRepo((dir) => {
    put(dir, "package.json", OXFMT_REPO);
    put(dir, "CLAUDE.md", "# mine\n");
    installFormatter(dir, "oxfmt");
    const out = init(dir, "--no-mutation", "--preview", "railway");
    const args = argsOf(dir, "oxfmt");
    assert.ok(args.includes(".github/workflows/preview.yml"));
    assert.ok(args.includes("lefthook.yml"));
    assert.ok(!args.includes("CLAUDE.md"), "a kept file is not formatted");
    assert.ok(!args.includes("."), "never the whole repo");
    assert.match(out, /format\s+.*oxfmt/);
  }));

test("re-run adds nothing, so the formatter doesn't run", () =>
  withRepo((dir) => {
    put(dir, "package.json", OXFMT_REPO);
    installFormatter(dir, "oxfmt");
    init(dir, "--no-mutation");
    rmSync(join(dir, "oxfmt.args"));
    init(dir, "--no-mutation");
    assert.equal(existsSync(join(dir, "oxfmt.args")), false);
  }));

test("a format script decides over other declared formatters", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({
      scripts: { "format:check": "oxfmt --check ." },
      devDependencies: { oxfmt: "1.0.0", prettier: "3.0.0" },
    }));
    installFormatter(dir, "oxfmt");
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "oxfmt.args")));
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("a declared formatter with no format script still runs, with the flags for it", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ devDependencies: { prettier: "3.0.0" } }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    const args = argsOf(dir, "prettier");
    assert.ok(args.includes("--write"));
    assert.ok(args.includes("--ignore-unknown"), "gantry-risky-paths has no extension");
  }));

test("a formatter that's only a transitive install is not the repo's formatter", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ devDependencies: { "some-lib": "1.0.0" } }));
    installFormatter(dir, "prettier");
    const out = init(dir, "--no-mutation");
    assert.equal(existsSync(join(dir, "prettier.args")), false);
    assert.match(out, /skip\s+format/);
  }));

test("no package.json: files are added unformatted and nothing warns", () =>
  withRepo((dir) => {
    const out = init(dir);
    assert.ok(existsSync(join(dir, "lefthook.yml")));
    assert.match(out, /skip\s+format/);
    assert.doesNotMatch(out, /^  ! .*format/im);
  }));

test("formatter declared but not installed: warns, doesn't fail", () =>
  withRepo((dir) => {
    put(dir, "package.json", OXFMT_REPO);
    assert.match(init(dir, "--no-mutation"), /! oxfmt is not installed.*run your formatter/i);
  }));

test("a format script gantry can't aim at single files: warns, doesn't fail", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: "dprint fmt" } }));
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
  }));

test("formatter fails: warns, keeps the files, doesn't fail", () =>
  withRepo((dir) => {
    put(dir, "package.json", OXFMT_REPO);
    installFormatter(dir, "oxfmt", 1);
    assert.match(init(dir, "--no-mutation"), /! oxfmt failed.*run your formatter/i);
    assert.ok(existsSync(join(dir, "lefthook.yml")));
  }));

test("a format script for another tool beats a declared prettier", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: "dprint fmt" }, devDependencies: { prettier: "3.0.0" } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("a script that only mentions a formatter's name doesn't count as running it", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { "lint:format": "eslint --rule prettier/prettier:error ." } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("two formatters in the scripts: warns and runs neither, since one may cover only some files", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: "biome format --write .", "format:md": 'prettier --write "**/*.md"' } }));
    installFormatter(dir, "biome");
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "biome.args")), false);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("a script running the formatter through npx or a path still counts", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { "format:check": "npx prettier --check ." } }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));
