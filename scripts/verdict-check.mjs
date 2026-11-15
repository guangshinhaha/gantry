#!/usr/bin/env node
// Fail a labelled PR unless a verifier's verdict for its current head is posted.
// Used by the verdict-check workflow and, from a terminal or script, by
// bin/gantry-verdict-check; evaluate() is exported for node:test.
//
//   GH_TOKEN=... REPO=owner/name PR=123 [LABEL=risk:high] [TRUSTED=OWNER,MEMBER,COLLABORATOR] \
//     node scripts/verdict-check.mjs
//   node scripts/verdict-check.mjs --pr 123 [--repo owner/name] [--label <name> | --no-label] [--trusted A,B]
//
// With any flag the env is ignored: flags or the env, never a mix. --no-label checks the PR whether or not it carries
// the label. Without a repo, uses the current directory's (`gh repo view`).
// Exit 0: pass, or skip (no label); 1: fail; 2: bad arguments or gh failed.
//
// A verdict is a JSON object in a PR comment, bare or in a code fence:
//   {"pr": 12, "head_sha": "<40 hex>", "verdict": "PASS|PASS+NOTES|FAIL", "evidence": [...]}
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
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
 * status: "skip" (PR doesn't carry the label), "pass" or "fail". `label: null`
 * checks every PR: it never skips.
 * Only verdicts from trusted authors, for this PR (when `pr` is given) and for
 * exactly the current head count. The newest of those decides: FAIL fails.
 * `comments` need id, created_at, body, author_association.
 */
export function evaluate({ prNumber, headSha, labels, label = DEFAULT_LABEL, comments, trusted = DEFAULT_TRUSTED }) {
  if (label !== null && !labels.map((l) => l.toLowerCase()).includes(label.toLowerCase())) {
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

/** Options from flags, or from the env when there are none. Throws Error(message) on a bad argument. */
export function parseArgs(argv, env = {}) {
  const o = {
    repo: "",
    pr: "",
    label: DEFAULT_LABEL,
    trusted: DEFAULT_TRUSTED.join(","),
  };
  // The env is the workflow's interface, read only when no flag is given, so a
  // stray REPO, PR or LABEL in a shell can't redirect a command-line check.
  if (!argv.length) {
    o.repo = env.REPO || "";
    o.pr = env.PR || "";
    o.label = env.LABEL || DEFAULT_LABEL;
    o.trusted = env.TRUSTED || o.trusted;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("-")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--repo") o.repo = val();
    else if (a === "--pr") o.pr = val();
    else if (a === "--label") o.label = val();
    else if (a === "--no-label") o.label = null;
    else if (a === "--trusted") o.trusted = val();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^[1-9][0-9]*$/.test(String(o.pr))) throw new Error("--pr <number> is required");
  if (o.repo && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`--repo must be owner/name, got: ${o.repo}`);
  return {
    ...o,
    pr: Number(o.pr),
    trusted: o.trusted.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function main() {
  let o, r;
  try {
    o = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(`verdict-check: ${e.message}`);
    return 2;
  }
  try {
    const repo = o.repo ||
      execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
    // Live PR state, not the event payload: a re-run carries the payload of the original run.
    const prData = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/pulls/${o.pr}`], { encoding: "utf8" }));
    const comments = gh(`repos/${repo}/issues/${o.pr}/comments?per_page=100`);
    r = evaluate({
      prNumber: o.pr,
      headSha: prData.head.sha,
      labels: prData.labels.map((l) => l.name),
      label: o.label,
      comments,
      trusted: o.trusted,
    });
  } catch (e) {
    console.error(`verdict-check: could not read PR ${o.pr} from GitHub: ${e.message}`);
    return 2;
  }
  const line = `${r.status.toUpperCase()}: ${r.reason}`;
  // An Actions annotation in the workflow; plain text in a terminal or script.
  console.log(r.status === "fail" && process.env.GITHUB_ACTIONS ? `::error::${r.reason}` : line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### verdict-check\n\n${line}\n`);
  return r.status === "fail" ? 1 : 0;
}

// Run as a script, whatever symlinks are in the path it was started by
// (import.meta.url is already resolved; argv[1] is not).
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exit(main());
