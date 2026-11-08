#!/usr/bin/env node
// Used by gantry-init. Detects the repo's test runner, writes stryker.config.mjs
// from the template, and prints the dev dependencies to install, or "off: <why>".
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const off = (why) => { console.log(`off: ${why}`); process.exit(0); };
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.workspaces || existsSync("pnpm-workspace.yaml")) off("monorepo: add a config per package");
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const test = pkg.scripts?.test ?? "";
const runner = deps.vitest ? "vitest" : deps.jest ? "jest" : null;
if (!runner) off(/--test\b/.test(test) ? "node:test is too slow under Stryker" : "no Vitest or Jest tests");
// The vitest runner needs vitest 2+, and npm refuses the install on vitest 1 (#14).
// A declared range that names a version decides, since npm resolves from it; the
// installed version counts only when it names none (*, latest, workspace:*).
if (runner === "vitest") {
  let version = String(deps.vitest).replace(/^(npm:vitest@|workspace:)/, "");
  if (!/\d/.test(version)) {
    try { version = JSON.parse(readFileSync("node_modules/vitest/package.json", "utf8")).version; } catch {}
  }
  // A hyphen range "a - b" is below 2 only if b is; else the lowest version or an upper bound decides.
  const below2 = (alt) => alt.includes(" - ") ? /^\s*[\^~=v]*\s*[01](\D|$)/.test(alt.split(" - ")[1])
    : /^\s*[\^~=v]*\s*[01](\D|$)/.test(alt) || /<\s*2(\.0)*(-\S*)?(\s|$)|<=\s*1(\D|$)/.test(alt);
  if (/\d/.test(version) && version.split("||").every(below2)) off(`vitest <2: found ${version}, and the Stryker runner needs 2+`);
}

const cfg = test.match(/--config[= ](\S+)/)?.[1];
const options = cfg ? `${runner}: { configFile: "${cfg}" },` : "";
const ts = existsSync("tsconfig.json");
let out = readFileSync(process.argv[2], "utf8")
  .replace("__RUNNER__", runner)
  .replace(/^ *__RUNNER_OPTIONS__\n/m, options ? `  ${options}\n` : "");
if (!ts) out = out.replace(/^ *checkers: .*\n/m, "");
writeFileSync("stryker.config.mjs", out);

const devDeps = ["@stryker-mutator/core", `@stryker-mutator/${runner}-runner`];
if (ts) devDeps.push("@stryker-mutator/typescript-checker");
console.log(devDeps.join(" "));
