import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

// A stand-in npm, so the mutation path runs with no network.
function initWithNpm(dir, npmExitCode, ...flags) {
  put(dir, "stub-bin/npm", `#!/bin/sh\nexit ${npmExitCode}\n`);
  chmodSync(join(dir, "stub-bin/npm"), 0o755);
  const env = { ...process.env, PATH: `${join(dir, "stub-bin")}:${process.env.PATH}` };
  return spawnSync(INIT, [dir, ...flags], { encoding: "utf8", env });
}
const VITEST_OXFMT = pkg({ scripts: { "format:check": "oxfmt --check ." }, devDependencies: { oxfmt: "1.0.0", vitest: "2.0.0" } });

test("biome: runs through its format command, found from its scoped package name", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ devDependencies: { "@biomejs/biome": "2.0.0" } }));
    installFormatter(dir, "biome");
    init(dir, "--no-mutation");
    const args = argsOf(dir, "biome");
    assert.deepEqual(args.slice(0, 4), ["format", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true"]);
    assert.ok(args.includes("lefthook.yml"));
  }));

test("oxfmt: writes, and doesn't fail when every file it gets is ignored", () =>
  withRepo((dir) => {
    put(dir, "package.json", OXFMT_REPO);
    installFormatter(dir, "oxfmt");
    init(dir, "--no-mutation");
    const args = argsOf(dir, "oxfmt");
    assert.ok(args.includes("--no-error-on-unmatched-pattern"));
    assert.ok(!args.includes("--check"));
  }));

test("mutation path: stryker.config.mjs is formatted too", () =>
  withRepo((dir) => {
    put(dir, "package.json", VITEST_OXFMT);
    installFormatter(dir, "oxfmt");
    assert.equal(initWithNpm(dir, 0).status, 0);
    assert.ok(argsOf(dir, "oxfmt").includes("stryker.config.mjs"));
  }));

test("a failed install warns, adds no mutation files, and the rest still runs", () =>
  withRepo((dir) => {
    put(dir, "package.json", VITEST_OXFMT);
    installFormatter(dir, "oxfmt");
    const run = initWithNpm(dir, 7, "--review");
    assert.equal(run.status, 0);
    assert.match(run.stdout, /! .*install failed.*mutation testing is off/i);
    assert.ok(existsSync(join(dir, ".github/workflows/review.yml")), "a later step still runs");
    assert.equal(existsSync(join(dir, "stryker.config.mjs")), false);
    assert.equal(existsSync(join(dir, ".github/workflows/mutation.yml")), false);
    assert.ok(argsOf(dir, "oxfmt").includes("lefthook.yml"));
    assert.ok(!argsOf(dir, "oxfmt").includes("stryker.config.mjs"));
  }));

test("pnpm repo: a failed pnpm add warns and the rest still runs", () =>
  withRepo((dir) => {
    put(dir, "package.json", VITEST_OXFMT);
    put(dir, "pnpm-lock.yaml", "");
    put(dir, "stub-bin/pnpm", "#!/bin/sh\necho \"$@\" > pnpm.args\nexit 1\n");
    chmodSync(join(dir, "stub-bin/pnpm"), 0o755);
    const run = initWithNpm(dir, 0, "--review");
    assert.equal(run.status, 0);
    assert.match(read(dir, "pnpm.args"), /^add -D @stryker-mutator\/core @stryker-mutator\/vitest-runner/);
    assert.match(run.stdout, /! .*install failed.*mutation testing is off/i);
    assert.ok(existsSync(join(dir, ".github/workflows/review.yml")));
    assert.equal(existsSync(join(dir, "stryker.config.mjs")), false);
  }));

const VITEST_STRYKER = (vitest) => pkg({ scripts: { test: "vitest run" }, devDependencies: { vitest } });
for (const vitest of ["1.6.0", "^1.6.0", "~1.2.0", "1.x", ">=1.0.0 <2", "<2", "npm:vitest@1.6.0", "0.34.6", "^1.0.0 || ~1.6.0", ">=1.0.0 <2.0.0-0", "1.0.0 - 1.9.9", "workspace:^1.6.0", "<=1.x"]) {
  test(`vitest ${vitest} in package.json: mutation is off, no install, the rest still runs`, () =>
    withRepo((dir) => {
      put(dir, "package.json", VITEST_STRYKER(vitest));
      const run = initWithNpm(dir, 7, "--review");
      assert.equal(run.status, 0);
      assert.match(run.stdout, /skip\s+mutation testing \(vitest <2/);
      assert.ok(existsSync(join(dir, ".github/workflows/review.yml")));
      assert.equal(existsSync(join(dir, "stryker.config.mjs")), false);
      assert.equal(existsSync(join(dir, ".github/workflows/mutation.yml")), false);
    }));
}

test("a declared range with no version: the installed vitest decides", () =>
  withRepo((dir) => {
    put(dir, "package.json", VITEST_STRYKER("*"));
    put(dir, "node_modules/vitest/package.json", JSON.stringify({ name: "vitest", version: "1.6.1" }));
    assert.match(initWithNpm(dir, 0).stdout, /skip\s+mutation testing \(vitest <2/);
  }));

test("a declared vitest 2 range decides over a stale installed vitest 1", () =>
  withRepo((dir) => {
    put(dir, "package.json", VITEST_STRYKER("^2.1.0"));
    put(dir, "node_modules/vitest/package.json", JSON.stringify({ name: "vitest", version: "1.6.1" }));
    assert.match(initWithNpm(dir, 0).stdout, /install .*vitest-runner/);
  }));

for (const vitest of ["^2.1.0", "3.2.4", "latest", ">=1.6", "^1.6.0 || ^2.0.0", "10.0.0", "1.0.0 - 2.0.0", "workspace:*"]) {
  test(`vitest ${vitest}: mutation is set up`, () =>
    withRepo((dir) => {
      put(dir, "package.json", VITEST_STRYKER(vitest));
      const run = initWithNpm(dir, 0);
      assert.equal(run.status, 0);
      assert.match(run.stdout, /install .*@stryker-mutator\/vitest-runner/);
      assert.ok(existsSync(join(dir, "stryker.config.mjs")));
      assert.ok(existsSync(join(dir, ".github/workflows/mutation.yml")));
    }));
}

test("a formatter is picked once, even when the run exits after formatting", () =>
  withRepo((dir) => {
    put(dir, "package.json", OXFMT_REPO);
    put(dir, "oxfmt-count", "");
    put(dir, "node_modules/.bin/oxfmt", "#!/bin/sh\necho x >> oxfmt-count\n");
    chmodSync(join(dir, "node_modules/.bin/oxfmt"), 0o755);
    init(dir, "--no-mutation"); // .husky makes this exit right after formatting
    assert.equal(read(dir, "oxfmt-count"), "x\n");
  }));

const runsTool = {
  "npx prettier@3 --write .": "prettier",
  "pnpm dlx oxfmt@latest": "oxfmt",
  "pnpm exec prettier --check .": "prettier",
  "yarn prettier --check .": "prettier",
  "yarn run prettier --check .": "prettier",
  "cross-env CI=1 oxfmt .": "oxfmt",
  "NODE_ENV=ci oxfmt .": "oxfmt",
  "./node_modules/.bin/biome format .": "biome",
};
for (const [command, tool] of Object.entries(runsTool)) {
  test(`script "${command}" runs ${tool}`, () =>
    withRepo((dir) => {
      put(dir, "package.json", pkg({ scripts: { format: command } }));
      installFormatter(dir, tool);
      init(dir, "--no-mutation");
      assert.ok(existsSync(join(dir, `${tool}.args`)));
    }));
}

for (const command of [
  "eslint --fix --plugin prettier .",
  "dprint fmt --config config/prettier",
  "pnpm --filter prettier exec tsc",
  'npm ls | grep -E "eslint|prettier"',
  "sh -c 'prettier --write .'",
  "npx --yes prettier --check .",
]) {
  test(`script "${command}" doesn't run prettier`, () =>
    withRepo((dir) => {
      put(dir, "package.json", pkg({ scripts: { format: command } }));
      installFormatter(dir, "prettier");
      assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
      assert.equal(existsSync(join(dir, "prettier.args")), false);
    }));
}

test("a formatter owning the repo from a script not named format blocks a partial one", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({
      scripts: { check: "biome ci .", "format:md": 'prettier --write "**/*.md"' },
      devDependencies: { "@biomejs/biome": "2.0.0", prettier: "3.0.0" },
    }));
    installFormatter(dir, "biome");
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "biome.args")), false);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("a formatter run from a script not named format counts", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { lint: "prettier --check ." } }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));

for (const name of ["docs:information", "formatjs:extract"]) {
  test(`script named ${name} isn't a format script`, () =>
    withRepo((dir) => {
      put(dir, "package.json", pkg({ scripts: { [name]: "node x" }, devDependencies: { prettier: "3.0.0" } }));
      installFormatter(dir, "prettier");
      init(dir, "--no-mutation");
      assert.ok(existsSync(join(dir, "prettier.args")));
    }));
}

test("a format script for another tool beats prettier in an unrelated script", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: "dprint fmt", gen: "codegen && prettier --write src/gen" } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

// Each is a repo where running the one visible formatter on the added files
// could turn its real check red, so it warns and runs nothing.
const ambiguous = {
  "a partial prettier script next to a format script for another tool": {
    scripts: { format: "dprint fmt", "format:md": 'prettier --write "**/*.md"' },
  },
  "a camelCase format script for another tool": {
    scripts: { formatCheck: "dprint check" }, devDependencies: { prettier: "3.0.0" },
  },
  "a dotted format script for another tool": {
    scripts: { "format.check": "dprint check" }, devDependencies: { prettier: "3.0.0" },
  },
  "prettier in an unrelated script, biome declared": {
    scripts: { gen: "codegen && prettier --write src/gen" },
    devDependencies: { "@biomejs/biome": "2.0.0", prettier: "3.0.0" },
  },
  "a config file passed on the command line": {
    scripts: { "format:check": "prettier --config config/prettier.json --check ." },
  },
  "a style option passed on the command line": {
    scripts: { format: "prettier --single-quote --write ." },
  },
  "biome's config path passed on the command line": {
    scripts: { format: "biome format --config-path=config --write ." },
  },
};
for (const [name, fields] of Object.entries(ambiguous)) {
  test(`warns and runs nothing: ${name}`, () =>
    withRepo((dir) => {
      put(dir, "package.json", pkg(fields));
      installFormatter(dir, "prettier");
      installFormatter(dir, "biome");
      assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
      assert.equal(existsSync(join(dir, "prettier.args")), false);
      assert.equal(existsSync(join(dir, "biome.args")), false);
    }));
}

test("a format script that calls another script runs what that script runs", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({
      scripts: { format: "prettier --write .", "format:check": "npm run format -- --check" },
    }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));

test('a quoted env value before the tool still reads as the tool', () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: 'FOO="a b" prettier --write .' } }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));

test("a script named after its tool isn't read as a call to itself", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { prettier: "prettier --check .", format: "npm run prettier" } }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));

test("scripts that call themselves or each other don't hide the formatter", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({
      scripts: { format: "prettier --write .", vitest: "vitest", ping: "npm run pong", pong: "npm run ping" },
    }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));

test("flags forwarded to another script count as options passed", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({
      scripts: { fmt: "prettier --write .", "format:ci": "npm run fmt -- --config x.json" },
    }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

for (const name of ["check:formatting", "reformat", "checkFormatting", "formatter"]) {
  test(`script named ${name} is a format script`, () =>
    withRepo((dir) => {
      put(dir, "package.json", pkg({ scripts: { [name]: "dprint check" }, devDependencies: { prettier: "3.0.0" } }));
      installFormatter(dir, "prettier");
      assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
      assert.equal(existsSync(join(dir, "prettier.args")), false);
    }));
}

test("a script entry that isn't a string is ignored", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: "prettier --write .", x: null, y: 3 } }));
    installFormatter(dir, "prettier");
    init(dir, "--no-mutation");
    assert.ok(existsSync(join(dir, "prettier.args")));
  }));

test("a format script that runs another tool too isn't evidence for prettier", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format: 'dprint fmt && prettier --write "**/*.md"' } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("script named formats is a format script", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { formats: "dprint fmt" }, devDependencies: { prettier: "3.0.0" } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

for (const format of ["prettier --write src && dprint fmt", "prettier --write . && dprint fmt", "tsc --noEmit && prettier --check ."]) test(`"${format}" isn't clear evidence for prettier`, () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { format } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("a pre or post hook of a format script counts as a format script", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { preformat: "dprint fmt", format: 'prettier --write "**/*.md"' } }));
    installFormatter(dir, "prettier");
    assert.match(init(dir, "--no-mutation"), /! .*run your formatter/i);
    assert.equal(existsSync(join(dir, "prettier.args")), false);
  }));

test("biome lint isn't evidence that biome formats", () =>
  withRepo((dir) => {
    put(dir, "package.json", pkg({ scripts: { lint: "biome lint ." } }));
    installFormatter(dir, "biome");
    init(dir, "--no-mutation");
    assert.equal(existsSync(join(dir, "biome.args")), false);
  }));
