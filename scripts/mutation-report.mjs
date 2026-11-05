#!/usr/bin/env node
// Turn Stryker's JSON report into a Markdown summary of surviving mutants.
// Used by the mutation workflow for the PR comment, and by Claude locally:
//
//   node scripts/mutation-report.mjs [reports/mutation/mutation.json] [--max 40]
//
// The workflow also passes what Stryker did, so the comment names the real cause:
//   --rc <exit code>  --log <stryker output file>  --files <comma-separated mutated files>
//   --classify        print only the outcome kind (see classify) and exit
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// What happened in the Stryker run. Only "below-break" is a real failure:
// mutation testing is report-only unless the repo sets thresholds.break.
export function classify(rc, log = "") {
  if (rc === 0) return "ok";
  if (rc === 124) return "timeout";
  if (/No tests were executed/.test(log)) return "no-tests";
  if (/failed tests in the initial test run/.test(log)) return "tests-failing";
  if (/under breaking threshold/.test(log)) return "below-break";
  return "error";
}

// Markdown for the non-ok outcomes (empty string when the report speaks for itself).
export function notice(kind, { files = [], cap = 15, rc } = {}) {
  switch (kind) {
    case "timeout":
      return `> ⏱ Stopped at the ${cap}-minute cap, so there is no result. Split the PR, or run locally: \`npx stryker run --mutate <file>\`.`;
    case "no-tests": {
      const list = files.length ? ["", ...files.map((f) => `- \`${f}\``)] : [];
      return [
        "> ⚠️ **No tests cover the changed code**, so there was nothing to mutate. Add tests for:",
        ...list,
      ].join("\n");
    }
    case "tests-failing":
      return "> ⏭ Tests are failing, so mutation testing was skipped. See the test job for the failures.";
    case "below-break":
      return "> ❌ Below the repo's `thresholds.break`.";
    case "error":
      return `> ⚠️ Stryker exited with an error (code ${rc}) and produced no result. See the run log. This does not fail the check.`;
    default:
      return "";
  }
}

// Files whose every mutant has no covering test.
export function untestedFiles(report) {
  const out = [];
  for (const [path, f] of Object.entries(report.files ?? {})) {
    const st = f.mutants.map((m) => m.status);
    if (st.includes("NoCoverage") && !st.some((s) => s === "Killed" || s === "Timeout" || s === "Survived")) out.push(path);
  }
  return out;
}

export function summarise(report, max = 40) {
  const count = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 };
  const survivors = [];
  const perFile = [];

  for (const [path, f] of Object.entries(report.files ?? {})) {
    const lines = f.source.split("\n");
    const c = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 };
    for (const m of f.mutants) {
      if (!(m.status in c)) continue; // Ignored, CompileError, RuntimeError, Pending
      c[m.status]++;
      count[m.status]++;
      if (m.status === "Survived" || m.status === "NoCoverage") {
        const { line, column } = m.location.start;
        const original = (lines[line - 1] ?? "").trim();
        survivors.push({ path, line, column, mutator: m.mutatorName, replacement: m.replacement, status: m.status, original });
      }
    }
    const total = c.Killed + c.Timeout + c.Survived + c.NoCoverage;
    if (total) perFile.push({ path, score: (100 * (c.Killed + c.Timeout)) / total, total });
}

const detected = count.Killed + count.Timeout;
const valid = detected + count.Survived + count.NoCoverage;
const score = valid ? (100 * detected) / valid : 100;
const clip = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/`/g, "ˋ");

const out = [];
out.push(`**Mutation score ${score.toFixed(1)}%** (${detected}/${valid} killed, ${perFile.length} files)`);
if (!valid) out.push("", "No mutants to test.");
if (perFile.length > 1) {
  out.push("", "| File | Score | Mutants |", "|---|---|---|");
  for (const p of perFile.sort((a, b) => a.score - b.score)) out.push(`| \`${p.path}\` | ${p.score.toFixed(0)}% | ${p.total} |`);
}
const untested = untestedFiles(report);
if (untested.length) {
  out.push("", "**No tests cover these files:**", "", ...untested.map((p) => `- \`${p}\``));
}
if (survivors.length) {
  out.push("", `**${survivors.length} survived** (no test failed when the code was changed):`, "");
  for (const s of survivors.slice(0, max)) {
    const tag = s.status === "NoCoverage" ? " — no test runs this line" : "";
    out.push(`- \`${s.path}:${s.line}\` ${s.mutator}: \`${clip(s.original)}\` → \`${clip(s.replacement ?? "")}\`${tag}`);
  }
  if (survivors.length > max) out.push(`- …and ${survivors.length - max} more in the HTML report.`);
  out.push(
    "",
    "To fix: ask Claude to *kill the survivors* — add tests that fail on each change. " +
      "Don't change app code to kill a mutant. If a change makes no real difference (equivalent mutant), " +
      "mark it `// Stryker disable next-line <Mutator>: <reason>`.",
  );
}
return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const max = Number(opt("--max") ?? 40);
  const rcArg = opt("--rc");
  const rc = rcArg === undefined ? 0 : Number(rcArg);
  const logFile = opt("--log");
  const files = (opt("--files") ?? "").split(",").filter(Boolean);
  const cap = Number(opt("--cap") ?? 15);
  const classifyOnly = args.includes("--classify");
  if (classifyOnly) args.splice(args.indexOf("--classify"), 1);
  const file = args[0] ?? "reports/mutation/mutation.json";

  const log = logFile && existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const kind = classify(rc, log);
  if (classifyOnly) {
    console.log(kind);
  } else if (kind !== "ok" && kind !== "below-break") {
    console.log(notice(kind, { files, cap, rc }));
  } else if (!existsSync(file)) {
    console.log(`No mutation report at \`${file}\`.`);
    if (kind === "below-break") console.log("\n" + notice(kind));
  } else {
    console.log(summarise(JSON.parse(readFileSync(file, "utf8")), max));
    if (kind === "below-break") console.log("\n" + notice(kind));
  }
}
