#!/usr/bin/env node
// Turn Stryker's JSON report into a Markdown summary of surviving mutants.
// Used by the mutation workflow for the PR comment, and by Claude locally:
//
//   node scripts/mutation-report.mjs [reports/mutation/mutation.json] [--max 40]
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const maxIdx = args.indexOf("--max");
const max = maxIdx >= 0 ? Number(args.splice(maxIdx, 2)[1]) : 40;
const file = args[0] ?? "reports/mutation/mutation.json";
if (!existsSync(file)) {
  console.log(`No mutation report at \`${file}\`.`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(file, "utf8"));
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
console.log(out.join("\n"));
