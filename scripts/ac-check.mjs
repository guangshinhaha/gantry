#!/usr/bin/env node
// Check that a PR ticks every acceptance criterion of the issues it closes.
// Used by the ac-check workflow; the parser is exported for node:test.
//
//   PR_BODY=... GH_TOKEN=... REPO=owner/name node scripts/ac-check.mjs
//   (or pass the PR number as PR=123 to fetch the body instead)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const stripNoise = (text) =>
  String(text ?? "")
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, "");

/** Issue numbers named by Closes/Fixes/Resolves #N (any tense), de-duplicated. */
export function linkedIssues(body) {
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+#(\d+)/gi;
  const found = new Set();
  for (const m of stripNoise(body).matchAll(re)) found.add(Number(m[1]));
  return [...found];
}

/** Checklist items under the "Acceptance criteria" heading, or null if there is no such section. */
export function acItems(body) {
  const lines = stripNoise(body).split("\n");
  const heading = /^(#{1,6})\s*acceptance criteria\s*:?\s*#*\s*$/i;
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const level = lines[start].match(heading)[1].length;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    const h = line.match(/^(#{1,6})\s/);
    if (h && h[1].length <= level) break;
    const m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (m) items.push({ done: m[1] !== " ", text: m[2].trim() });
  }
  return items;
}

/**
 * Compare a PR body with the bodies of its linked issues.
 * status: "skip" (nothing to check), "pass", or "fail".
 */
export function evaluate(prBody, issues) {
  const wanted = issues
    .map((i) => ({ number: i.number, items: acItems(i.body) ?? [] }))
    .filter((i) => i.items.length);
  if (!wanted.length) return { status: "skip", errors: [], warnings: [] };

  const errors = [];
  const warnings = [];
  const mine = acItems(prBody);
  if (!mine || !mine.length) {
    errors.push("The PR body needs an `## Acceptance criteria` section with the issue's checklist, each item ticked with evidence.");
  } else {
    for (const it of mine.filter((i) => !i.done)) errors.push(`Unticked: ${it.text || "(empty item)"}`);
    const most = Math.max(...wanted.map((i) => i.items.length));
    if (mine.length < most) {
      warnings.push(`The PR lists ${mine.length} criteria but the linked issue has ${most}. Paste the whole checklist.`);
    }
  }
  return { status: errors.length ? "fail" : "pass", errors, warnings };
}

function gh(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
}

function main() {
  const repo = process.env.REPO;
  let body = process.env.PR_BODY;
  if (body === undefined && process.env.PR) body = gh(`repos/${repo}/pulls/${process.env.PR}`).body;
  const issues = [];
  for (const n of linkedIssues(body)) {
    try {
      const i = gh(`repos/${repo}/issues/${n}`);
      if (!i.pull_request) issues.push({ number: n, body: i.body });
    } catch {
      console.log(`::notice::Could not read #${n}; skipping it.`);
    }
  }
  const r = evaluate(body, issues);
  if (r.status === "skip") {
    console.log("No linked issue with an Acceptance criteria checklist: nothing to check.");
    return 0;
  }
  for (const w of r.warnings) console.log(`::warning::${w}`);
  for (const e of r.errors) console.log(`::error::${e}`);
  if (r.status === "pass") console.log("All acceptance criteria are ticked.");
  return r.status === "fail" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
