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
// A single-version spec (^1.6.0, ~1.2, 1.x) pins the major npm resolves to, so it
// decides. Any other range: the resolved version decides, from node_modules or
// package-lock.json. With neither, go ahead; a failed install is not fatal.
if (runner === "vitest") {
  const declared = String(deps.vitest);
  const json = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
  const resolved = json("node_modules/vitest/package.json")?.version
    ?? json("package-lock.json")?.packages?.["node_modules/vitest"]?.version;
  const single = declared.match(/^(?:npm:vitest@|workspace:)?[\^~=v]?\s*(\d+)(\.[\dx*]+){0,2}(-[\w.]+)?$/);
  const found = single ? declared : resolved;
  const major = Number((single?.[1]) ?? String(resolved).match(/^v?(\d+)\./)?.[1]);
  if (major < 2) off(`vitest <2: found ${found}, and the Stryker runner needs 2+`);
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
