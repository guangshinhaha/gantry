// Match a PR's changed files against .github/gantry-risky-paths globs.
//
//   node risky-paths.mjs <globs-file> <changed-files-file> [--json]
//
// Globs: one per line, `#` comments, blank lines ignored.
//   **  any number of directories (also zero, in `**/`)
//   *   anything except `/`        ?  one character except `/`
// A glob with no `/` (e.g. `*rls*`) matches the file name at any depth.
// Prints a markdown list of "file  <- glob" lines (or JSON), empty when no match.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function parseGlobs(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function globToRegExp(glob) {
  let g = glob.replace(/^\//, "");
  if (!g.includes("/")) g = "**/" + g;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function match(globs, files) {
  const compiled = globs.map((g) => [g, globToRegExp(g)]);
  const out = [];
  for (const f of files) {
    const hit = compiled.filter(([, r]) => r.test(f)).map(([g]) => g);
    if (hit.length) out.push({ file: f, globs: hit });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [globsFile, filesFile, flag] = process.argv.slice(2);
  const globs = parseGlobs(readFileSync(globsFile, "utf8"));
  const files = readFileSync(filesFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const hits = match(globs, files);
  if (flag === "--json") console.log(JSON.stringify(hits));
  else for (const h of hits) console.log(`- \`${h.file}\` (${h.globs.map((g) => `\`${g}\``).join(", ")})`);
}
