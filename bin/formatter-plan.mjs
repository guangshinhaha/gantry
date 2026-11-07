#!/usr/bin/env node
// Used by gantry-init. Prints the one formatter to run on the files it added, or
// "unknown" to warn instead, or nothing when the repo has no formatter. It runs a
// formatter only on clear evidence. A wrong guess can turn format:check red, and a
// warning can't. A binary in node_modules/.bin isn't evidence: prettier is often
// there only because another package pulled it in.
import { readFileSync } from "node:fs";

const PACKAGES = { oxfmt: "oxfmt", biome: "@biomejs/biome", prettier: "prettier" };
const tools = Object.keys(PACKAGES);
const LAUNCHERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "exec", "dlx", "run", "cross-env"]);
// Flags that don't change the output. Anything else, like --config or
// --single-quote, is an option we'd drop when calling the tool ourselves.
const HARMLESS_FLAGS = new Set(["--write", "-w", "--check", "--list-different", "-l", "--cache", "--ignore-unknown", "-u", "--", "--no-error-on-unmatched-pattern"]);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const scripts = pkg.scripts ?? {};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// The commands a script runs: each one's first word after env vars and launchers,
// so "eslint --plugin prettier ." runs eslint, and "npx prettier@3 ." runs prettier.
// Quoted text is dropped: it's an argument, as in grep "eslint|prettier". A call to
// another script counts as that script's commands, unless it's already being
// expanded: "vitest": "vitest" runs vitest, not itself.
function commandsIn(script, expanding = new Set()) {
  return script.replace(/"[^"]*"|'[^']*'/g, "").split(/&&|\|\||[;|&]/).flatMap((part) => {
    const words = part.replace(/[()]/g, " ").trim().split(/\s+/);
    const at = words.findIndex((word) => !LAUNCHERS.has(word) && !/^\w+=/.test(word));
    const name = (words[at] ?? "").split("/").pop().split("@")[0];
    if (!tools.includes(name) && Object.hasOwn(scripts, name) && !expanding.has(name)) {
      return commandsIn(scripts[name], new Set(expanding).add(name));
    }
    return [{ name, flags: words.slice(at + 1).filter((word) => word.startsWith("-")) }];
  });
}
const toolsIn = (commands) => tools.filter((tool) => commands.some((command) => command.name === tool));

const isFormatScript = (name) => /(^|[^a-z])(format|fmt)([^a-z]|$)|(^|[a-z])(Format|Fmt)([^a-z]|$)/.test(name);
const all = Object.entries(scripts).flatMap(([name, script]) => commandsIn(script, new Set([name]))).filter((command) => tools.includes(command.name));
const formatScripts = Object.keys(scripts).filter(isFormatScript);
const otherToolFormats = formatScripts.some((name) => toolsIn(commandsIn(scripts[name], new Set([name]))).length === 0);
const passesOptions = all.some((command) => command.flags.some((flag) => !HARMLESS_FLAGS.has(flag)));
const declared = tools.filter((tool) => PACKAGES[tool] in deps);
// A format script is evidence that outranks a declared dependency. No format script
// isn't: the formatter may run from CI or an editor, and only some scripts show it.
const found = formatScripts.length
  ? toolsIn(all)
  : tools.filter((tool) => toolsIn(all).includes(tool) || declared.includes(tool));

if (otherToolFormats || passesOptions || found.length > 1) console.log("unknown");
else if (found.length === 1) console.log(found[0]);
