#!/usr/bin/env node
// Used by gantry-init. Prints the one formatter this repo uses: the one its format
// scripts run, or with no format scripts, the one it declares as a dependency.
// Prints "unknown" when that isn't exactly one of the tools we can aim at single
// files, and nothing when the repo has no formatter. A binary in node_modules/.bin
// proves nothing: prettier is often there only because another package pulled it in.
import { readFileSync } from "node:fs";

const PACKAGES = { oxfmt: "oxfmt", biome: "@biomejs/biome", prettier: "prettier" };
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const formatScripts = Object.entries(pkg.scripts ?? {})
  .filter(([name]) => /format|fmt/i.test(name))
  .map(([, command]) => command);
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// Run as a command, so not "eslint --rule prettier/prettier" or "eslint-config-prettier".
const runs = (command, tool) => new RegExp(`(^|[\\s;&|/])${tool}(?=[\\s;&|]|$)`).test(command);
const tools = Object.keys(PACKAGES);
const found = formatScripts.length
  ? tools.filter((tool) => formatScripts.some((command) => runs(command, tool)))
  : tools.filter((tool) => PACKAGES[tool] in deps);

if (found.length === 1) console.log(found[0]);
else if (found.length > 1 || formatScripts.length) console.log("unknown");
