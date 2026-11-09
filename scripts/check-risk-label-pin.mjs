// Flags a stale default `gantry-ref` in risk-label.yml.
//
//   node check-risk-label-pin.mjs [repo-root]
//
// risk-label downloads high-risk-paths.mjs and risky-paths.mjs at the pinned sha.
// If either differs from the checked-out copy, the pin is stale: exit 1 and name
// the files. A PR that edits those scripts can't know its own sha, so run this on
// the default branch after merge and bump the pin in a follow-up.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED = ["scripts/high-risk-paths.mjs", "scripts/risky-paths.mjs"];

/** The default sha of the gantry-ref input, or null. */
export function defaultPin(workflowText) {
  const m = workflowText.match(/gantry-ref:\n(?:\s+description:.*\n)?\s+type: string\n\s+default: ([0-9a-f]{40})\n/);
  return m ? m[1] : null;
}

/** Pinned scripts whose content at `sha` differs from the working tree. Throws if the sha can't be read. */
export function stale(root, sha) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { git("cat-file", "-e", `${sha}^{commit}`); } catch { git("fetch", "--depth=1", "origin", sha); }
  return PINNED.filter((f) => git("show", `${sha}:${f}`) !== readFileSync(join(root, f), "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? ".";
  const sha = defaultPin(readFileSync(join(root, ".github/workflows/risk-label.yml"), "utf8"));
  if (!sha) { console.error("::error::no default gantry-ref sha found in risk-label.yml"); process.exit(1); }
  let files;
  try { files = stale(root, sha); } catch (e) {
    console.error(`::error::can't compare the pin ${sha} with the tree: ${String(e.stderr || e.message).trim()}`);
    process.exit(1);
  }
  if (files.length) {
    console.error(`::error::risk-label's default gantry-ref ${sha} is stale: ${files.join(", ")} changed since. Bump it to a commit that has them.`);
    process.exit(1);
  }
  console.log(`gantry-ref ${sha} matches the checked-out matching scripts.`);
}
