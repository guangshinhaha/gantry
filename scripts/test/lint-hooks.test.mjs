import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Needs lefthook on PATH. own-ci installs it before node --test, so in CI a
// missing lefthook fails instead of skipping.
const skip = !process.env.CI && spawnSync("lefthook", ["version"]).status !== 0 && "lefthook not on PATH";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(edit) {
  const dir = mkdtempSync(join(tmpdir(), "lint-hooks-"));
  try {
    for (const p of ["hooks", "template/lefthook.yml", "scripts/lint-hooks.sh"]) {
      cpSync(join(repo, p), join(dir, p), { recursive: true });
    }
    edit?.(dir);
    return spawnSync("sh", [join(dir, "scripts/lint-hooks.sh")], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const append = (dir, file, text) => writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8") + text);

test("current hooks and template pass", { skip }, () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a duplicate key in a hook file fails, naming the file", { skip }, () => {
  const r = run((d) => append(d, "hooks/node.yml", "\npre-commit:\n  parallel: true\npre-commit:\n  parallel: false\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /file=hooks\/node\.yml::.*already defined/);
});

test("a duplicate key in the template fails", { skip }, () => {
  const r = run((d) => append(d, "template/lefthook.yml", "remotes: []\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /file=template\/lefthook\.yml::.*already defined/);
});

test("a hook file that a configs: line points at must exist, live or commented", { skip }, () => {
  for (const name of ["node.yml", "prisma.yml"]) {
    const r = run((d) => renameSync(join(d, "hooks", name), join(d, "hooks", "renamed-" + name)));
    assert.notEqual(r.status, 0, name);
    assert.match(r.stdout, new RegExp(`file=template/lefthook\\.yml,line=\\d+::configs: hooks/${name} does not exist`));
  }
});
