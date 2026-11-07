#!/usr/bin/env node
// Used by gantry-init. Prints the one formatter this repo uses: the one its scripts
// run, or if they run none, the one it declares as a dependency. Prints "unknown"
// when that isn't exactly one, or when a format script runs a tool we can't aim at
// single files, and nothing when the repo has no formatter. A binary in
// node_modules/.bin proves nothing: prettier is often there only because another
// package pulled it in.
import { readFileSync } from "node:fs";

const PACKAGES = { oxfmt: "oxfmt", biome: "@biomejs/biome", prettier: "prettier" };
const LAUNCHERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "exec", "dlx", "cross-env", "sh", "bash"]);

// The commands a script runs: each one's first word after env vars and launchers,
// so "eslint --plugin prettier ." runs eslint, and "npx prettier@3 ." runs prettier.
function commandsIn(script) {
  return script.split(/&&|\|\||[;|&]/).map((part) => {
    const words = part.trim().split(/\s+/).map((word) => word.replace(/^['"(]+|['")]+$/g, ""));
    const word = words.find((w) => !LAUNCHERS.has(w) && !w.startsWith("-") && !/^\w+=/.test(w)) ?? "";
    return word.split("/").pop().split("@")[0];
  });
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const scripts = Object.entries(pkg.scripts ?? {});
const tools = Object.keys(PACKAGES);
const toolsIn = (entries) => {
  const commands = entries.flatMap(([, script]) => commandsIn(script));
  return tools.filter((tool) => commands.includes(tool));
};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

const formatScripts = scripts.filter(([name]) => /(^|[:_-])(format|fmt)($|[:_-])/i.test(name));
const scripted = toolsIn(scripts);
const found = scripted.length ? scripted : tools.filter((tool) => PACKAGES[tool] in deps);
const unaimable = formatScripts.length > 0 && toolsIn(formatScripts).length === 0;

if (unaimable || found.length > 1) console.log("unknown");
else if (found.length === 1) console.log(found[0]);
