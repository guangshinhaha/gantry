#!/usr/bin/env node
// Fail a labelled PR unless a verifier's verdict for its current head is posted.
// Used by the verdict-check workflow; evaluate() is exported for node:test.
//
//   GH_TOKEN=... REPO=owner/name PR=123 [LABEL=risk:high] [TRUSTED=OWNER,MEMBER,COLLABORATOR] \
//     node scripts/verdict-check.mjs
//
// A verdict is a JSON object in a PR comment, bare or in a code fence:
//   {"pr": 12, "head_sha": "<40 hex>", "verdict": "PASS|PASS+NOTES|FAIL", "evidence": [...]}
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERDICTS = new Set(["PASS", "PASS+NOTES", "FAIL"]);
export const DEFAULT_LABEL = "risk:high";
export const DEFAULT_TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

/** Every top-level `{...}` in text that parses as JSON, in order. Braces inside strings are handled. */
export function jsonObjects(text) {
  const out = [];
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { out.push(JSON.parse(s.slice(i, j + 1))); i = j; } catch { /* not JSON: keep scanning inside it */ }
        break;
      }
    }
  }
  return out;
}

/** Verdict objects in a comment body: head_sha is a string and verdict is one of VERDICTS. */
export function verdictsIn(body) {
  return jsonObjects(body).filter(
    (o) => o && typeof o === "object" && typeof o.head_sha === "string" && VERDICTS.has(o.verdict),
  );
}

/**
 * status: "skip" (PR doesn't carry the label), "pass" or "fail".
 * Only verdicts from trusted authors, for this PR (when `pr` is given) and for
 * exactly the current head count. The newest of those decides: FAIL fails.
 * `comments` need id, created_at, body, author_association.
 */
export function evaluate({ prNumber, headSha, labels, label = DEFAULT_LABEL, comments, trusted = DEFAULT_TRUSTED }) {
  if (!labels.map((l) => l.toLowerCase()).includes(label.toLowerCase())) {
    return { status: "skip", reason: `PR has no \`${label}\` label: nothing to check.` };
  }
  const head = headSha.toLowerCase();
  const found = [];
  for (const c of comments) {
    if (!trusted.includes(c.author_association)) continue;
    for (const v of verdictsIn(c.body)) {
      if (v.head_sha.toLowerCase() !== head) continue;
      if (v.pr !== undefined && Number(v.pr) !== Number(prNumber)) continue;
      found.push({ ...v, commentId: c.id, at: c.updated_at ?? c.created_at });
    }
  }
  if (!found.length) {
    return {
      status: "fail",
      reason: `No verdict for head ${head.slice(0, 7)} from ${trusted.join("/")}. Post {pr, head_sha, verdict, evidence} as a PR comment, then re-run this check.`,
    };
  }
  // Order by last edit (an edit is a new statement), then comment id, then position within the comment (stable sort).
  found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.commentId - b.commentId));
  const last = found[found.length - 1];
  if (last.verdict === "FAIL") {
    return { status: "fail", reason: `Latest verdict at head ${head.slice(0, 7)} is FAIL (comment ${last.commentId}).` };
  }
  return { status: "pass", reason: `${last.verdict} verdict at head ${head.slice(0, 7)} (comment ${last.commentId}).` };
}

const gh = (path) => JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" })).flat();

function main() {
  const { REPO: repo, PR: pr } = process.env;
  const label = process.env.LABEL || DEFAULT_LABEL;
  const trusted = (process.env.TRUSTED || DEFAULT_TRUSTED.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  // Live PR state, not the event payload: a re-run carries the payload of the original run.
  const prData = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/pulls/${pr}`], { encoding: "utf8" }));
  const comments = gh(`repos/${repo}/issues/${pr}/comments?per_page=100`);
  const r = evaluate({
    prNumber: Number(pr),
    headSha: prData.head.sha,
    labels: prData.labels.map((l) => l.name),
    label,
    comments,
    trusted,
  });
  const line = `${r.status.toUpperCase()}: ${r.reason}`;
  console.log(r.status === "fail" ? `::error::${r.reason}` : line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### verdict-check\n\n${line}\n`);
  return r.status === "fail" ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
