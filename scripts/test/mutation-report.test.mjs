import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, notice, summarise, untestedFiles } from "../mutation-report.mjs";

const script = new URL("../mutation-report.mjs", import.meta.url).pathname;
const NO_TESTS = "ERROR Stryker No tests were executed. Stryker will exit prematurely.";
const FAILING = "ERROR DryRunExecutor One or more tests failed in the initial test run:\n\tfoo\nERROR Stryker There were failed tests in the initial test run.";
const BREAK = "ERROR Final mutation score 40.00 under breaking threshold 60, setting exit code to 1 (failure).";

test("classify names the real cause", () => {
  assert.equal(classify(0), "ok");
  assert.equal(classify(124), "timeout");
  assert.equal(classify(1, NO_TESTS), "no-tests");
  assert.equal(classify(1, FAILING), "tests-failing");
  assert.equal(classify(1, BREAK), "below-break");
  assert.equal(classify(1, "Starting initial test run\n" + BREAK), "below-break");
  assert.equal(classify(1, "something else broke"), "error");
  assert.equal(classify(1), "error");
});

test("no-tests lists the files and never blames thresholds.break", () => {
  const msg = notice("no-tests", { files: ["src/a.ts", "src/b.ts"] });
  assert.match(msg, /No tests cover the changed code/);
  assert.match(msg, /- `src\/a\.ts`\n- `src\/b\.ts`/);
  assert.doesNotMatch(msg, /thresholds\.break/);
});

test("tests-failing says skipped and never blames thresholds.break", () => {
  const msg = notice("tests-failing");
  assert.match(msg, /Tests are failing, so mutation testing was skipped/);
  assert.doesNotMatch(msg, /thresholds\.break/);
});

test("only below-break mentions thresholds.break", () => {
  assert.match(notice("below-break"), /Below the repo's `thresholds\.break`/);
  for (const k of ["ok", "timeout", "no-tests", "tests-failing", "error"]) {
    assert.doesNotMatch(notice(k, { rc: 1 }), /thresholds\.break/, k);
  }
});

const mutant = (status) => ({ status, mutatorName: "M", location: { start: { line: 1, column: 1 } }, replacement: "x" });
const report = {
  files: {
    "src/tested.ts": { source: "a", mutants: [mutant("Killed"), mutant("NoCoverage")] },
    "src/untested.ts": { source: "b", mutants: [mutant("NoCoverage"), mutant("NoCoverage")] },
  },
};

test("untestedFiles flags files where no mutant is covered", () => {
  assert.deepEqual(untestedFiles(report), ["src/untested.ts"]);
});

test("summarise names untested files", () => {
  assert.match(summarise(report), /No tests cover these files:\*\*\n\n- `src\/untested\.ts`/);
});

test("CLI: no-tests and failing-tests print their message from the log", () => {
  const dir = mkdtempSync(join(tmpdir(), "mut-"));
  const run = (log, ...extra) => {
    const f = join(dir, "log.txt");
    writeFileSync(f, log);
    return execFileSync("node", [script, join(dir, "none.json"), "--rc", "1", "--log", f, ...extra], { encoding: "utf8" });
  };
  assert.match(run(NO_TESTS, "--files", "src/new.ts"), /- `src\/new\.ts`/);
  assert.match(run(FAILING), /mutation testing was skipped/);
  assert.equal(run(BREAK, "--classify").trim(), "below-break");
});
