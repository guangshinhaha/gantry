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
// Some tools leave non-string entries in scripts; they run nothing.
const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, script]) => typeof script === "string"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// The commands a script runs: each one's first word after env vars and launchers,
// so "eslint --plugin prettier ." runs eslint, and "npx prettier@3 ." runs prettier.
// Quoted text is dropped: it's an argument, as in grep "eslint|prettier". A call to
// another script counts as that script's commands, with any flags it forwards
// ("npm run fmt -- --config x"), unless it's already being expanded: "vitest":
// "vitest" runs vitest, not itself.
function commandsIn(script, expanding = new Set()) {
  return script.replace(/"[^"]*"|'[^']*'/g, "").split(/&&|\|\||[;|&]/).flatMap((part) => {
    const words = part.replace(/[()]/g, " ").trim().split(/\s+/);
    const at = words.findIndex((word) => !LAUNCHERS.has(word) && !/^\w+=/.test(word));
    const name = (words[at] ?? "").split("/").pop().split("@")[0];
    const flags = words.slice(at + 1).filter((word) => word.startsWith("-"));
    if (!tools.includes(name) && Object.hasOwn(scripts, name) && !expanding.has(name)) {
      return commandsIn(scripts[name], new Set(expanding).add(name))
        .map((command) => ({ ...command, flags: [...command.flags, ...flags] }));
    }
    // biome lint never formats, so it says nothing about the formatter.
    if (name === "biome" && words[at + 1] === "lint") return [{ name: "biome lint", flags }];
    return [{ name, flags }];
  });
}
const toolsIn = (commands) => tools.filter((tool) => commands.some((command) => command.name === tool));

// format, fmt, reformat, formats, formatting, formatter, their npm pre/post hooks
// and camelCase forms, but not formatjs or information.
const isFormatScript = (name) =>
  /(^|[^a-z])(pre|post|re)?(format|fmt)(ting|ter|s)?([^a-z]|$)|(^|[a-z])(Format|Fmt)(ting|ter|s)?([^a-z]|$)/.test(name);
const all = Object.entries(scripts).flatMap(([name, script]) => commandsIn(script, new Set([name]))).filter((command) => tools.includes(command.name));
const formatScripts = Object.keys(scripts).filter(isFormatScript);
// A format script that runs anything besides a supported tool may format some
// files with it ("prettier --write . && dprint fmt"), so it isn't clear evidence.
const otherToolFormats = formatScripts.some((name) =>
  commandsIn(scripts[name], new Set([name])).some((command) => command.name && !tools.includes(command.name)));
const passesOptions = all.some((command) => command.flags.some((flag) => !HARMLESS_FLAGS.has(flag)));
const declared = tools.filter((tool) => PACKAGES[tool] in deps);
// A format script is evidence that outranks a declared dependency. No format script
// isn't: the formatter may run from CI or an editor, and only some scripts show it.
const found = formatScripts.length
  ? toolsIn(all)
  : tools.filter((tool) => toolsIn(all).includes(tool) || declared.includes(tool));

if (otherToolFormats || passesOptions || found.length > 1) console.log("unknown");
else if (found.length === 1) console.log(found[0]);
