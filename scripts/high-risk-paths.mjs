// Which changed files make a PR High-risk (so it gets the `risk:high` label).
//
//   node high-risk-paths.mjs <repo-globs-file> <changed-files-file>
//
// The globs are DEFAULT_GLOBS plus the lines of the repo's own list
// (.github/gantry-high-risk-paths, same format as gantry-risky-paths). The repo
// list only adds; it can't remove a default. A missing list file is fine.
// Prints "- `file` (`glob`)" lines, empty when nothing matches.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { match, parseGlobs } from "./risky-paths.mjs";

export const DEFAULT_GLOBS = [".github/workflows/**", "template/.github/**", "bin/gantry-protect"];

/** Changed files that match a default or repo glob: [{file, globs}]. */
export function highRisk(files, repoGlobsText = "") {
  return match([...DEFAULT_GLOBS, ...parseGlobs(repoGlobsText)], files);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [listFile, changedFile] = process.argv.slice(2);
  const list = existsSync(listFile) ? readFileSync(listFile, "utf8") : "";
  const files = readFileSync(changedFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const h of highRisk(files, list)) console.log(`- \`${h.file}\` (${h.globs.map((g) => `\`${g}\``).join(", ")})`);
}
