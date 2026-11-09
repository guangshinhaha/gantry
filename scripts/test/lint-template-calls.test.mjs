import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Needs actionlint on PATH. own-ci installs it before node --test, so in CI a
// missing actionlint fails instead of skipping.
const skip =
  !process.env.CI && spawnSync("actionlint", ["--version"]).status !== 0 && "actionlint not on PATH";
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

test("current templates pass", { skip }, () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a live input the shared workflow dropped fails, pointing at template/", { skip }, () => {
  const r = run((d) => sub(d, ".github/workflows/preview.yml", "\n      platform:\n", "\n      platform-x:\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /file=template\/\.github\/workflows\/preview\.yml,line=\d+.*input "platform" is not defined/);
});

test("a shared-workflow call that isn't repointed fails", { skip }, () => {
  const r = run((d) =>
    sub(d, "template/.github/workflows/ci.yml", "guangshinhaha/gantry/.github", "someone/fork/.github"),
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /file=template\/\.github\/workflows\/ci\.yml,line=\d+::uses: is not/);
});

test("a commented-out optional input the shared workflow dropped fails", { skip }, () => {
  for (const [file, shared, input] of [
    ["ci.yml", "ci.yml", "e2e"],
    ["ci.yml", "ci.yml", "runs-on"],
    ["preview.yml", "preview.yml", "lighthouse-min-a11y"],
    ["secrets-scan.yml", "secrets-scan.yml", "runs-on"],
  ]) {
    const r = run((d) => sub(d, `.github/workflows/${shared}`, `\n      ${input}:`, `\n      ${input}-x:`));
    assert.notEqual(r.status, 0, `${file} ${input}`);
    assert.match(r.stdout, new RegExp(`file=template/\\.github/workflows/${file},line=\\d+.*input "${input}" is not defined`));
  }
});

test("a blank line ends the marker block: prose after it is not uncommented", { skip }, () => {
  const r = run((d) => {
    const p = join(d, "template/.github/workflows/ci.yml");
    writeFileSync(p, readFileSync(p, "utf8") + "\n# note: prose, not an input\n");
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
