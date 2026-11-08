import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Needs actionlint on PATH; own-ci installs it before node --test.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(edit) {
  const dir = mkdtempSync(join(tmpdir(), "lint-template-calls-"));
  try {
    for (const p of [".github/workflows", "template/.github/workflows", "scripts/lint-template-calls.sh"]) {
      cpSync(join(repo, p), join(dir, p), { recursive: true });
    }
    edit?.(dir);
    return spawnSync("sh", [join(dir, "scripts/lint-template-calls.sh")], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const sub = (dir, file, from, to) => {
  const p = join(dir, file);
  const s = readFileSync(p, "utf8");
  assert.ok(s.includes(from), `${file} lacks ${from}`);
  writeFileSync(p, s.replace(from, to));
};

test("current templates pass", () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a live input the shared workflow dropped fails, pointing at template/", () => {
  const r = run((d) => sub(d, ".github/workflows/preview.yml", "\n      platform:\n", "\n      platform-x:\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /file=template\/\.github\/workflows\/preview\.yml,line=\d+.*input "platform" is not defined/);
});

test("a commented-out option the shared workflow dropped fails", () => {
  const r = run((d) => sub(d, ".github/workflows/ci.yml", "\n      e2e:\n", "\n      e2e-x:\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /template\/\.github\/workflows\/ci\.yml.*input "e2e" is not defined/);
});

test("prose comments and alternatives to a live key stay comments", () => {
  const r = run((d) => {
    appendFileSync(join(d, "template/.github/workflows/ci.yml"), "    # Note: set e2e only on Linux\n");
    sub(d, "template/.github/workflows/preview.yml", "      # lighthouse: true", "      # platform: vercel\n      # lighthouse: true");
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
