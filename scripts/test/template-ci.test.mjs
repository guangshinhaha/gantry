// The ci callers that gantry-init copies. A PR's base change must re-run ci
// (gantry#65), and a title or body edit must not reset the required checks
// (gantry#134): `edited` is the only event GitHub fires for either, so it lives
// in its own workflow, ci-retarget.yml, which re-runs ci on a real base change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const caller = read("template/.github/workflows/ci.yml");
const retarget = read("template/.github/workflows/ci-retarget.yml");
const shared = read(".github/workflows/ci-retarget.yml");
const types = (yml) => (/pull_request:\s*\n\s*types:\s*\[([^\]]*)\]/.exec(yml)?.[1] ?? "").split(",").map((t) => t.trim());

test("template ci caller doesn't listen for edited, so a body edit adds no ci run", () => {
  // A skipped `edited` run would be ci's latest for the head and reset the
  // required `gantry / ci-ok` (gantry#134).
  assert.ok(!types(caller).includes("edited"), "edited belongs in ci-retarget.yml");
  assert.doesNotMatch(caller, /changes\.base/);
  // Setting `types` drops the defaults, so they must be listed again.
  for (const t of ["opened", "synchronize", "reopened"]) assert.ok(types(caller).includes(t), t);
});

test("template ci-retarget listens only for edited, and acts only on a base change", () => {
  assert.deepEqual(types(retarget), ["edited"]);
  assert.match(retarget, /^ {4}if: \$\{\{ github\.event\.changes\.base && !github\.event\.pull_request\.draft \}\}$/m);
  assert.match(retarget, /uses: guangshinhaha\/gantry\/\.github\/workflows\/ci-retarget\.yml@main/);
  // The re-run needs actions: write; without it the call fails at startup.
  assert.match(retarget, /permissions:\s*\n\s*actions: write/);
});

test("template ci-retarget makes no gantry / ci-ok of its own", () => {
  // Its runs are skipped on every title or body edit, and a skipped run is its
  // workflow's latest: a ci-ok kept here would vanish on the next edit, so the
  // result of the new base must live in ci's run (proved in gantry-sandbox, #134).
  const code = (yml) => yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code(retarget), /\/ci\.yml@/);
  assert.doesNotMatch(code(shared), /ci-ok|workflows\/ci\.yml@|uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(shared, /scripts\/ci-retarget\.mjs/);
});

test("shared ci-retarget re-runs only on a base change of a ready PR, and needs actions: write", () => {
  assert.match(shared, /if: \$\{\{ github\.event_name == 'pull_request' && github\.event\.action == 'edited' && github\.event\.changes\.base && !github\.event\.pull_request\.draft \}\}/);
  assert.match(shared, /^ {6}actions: write$/m);
});

test("the README's ci caller snippet matches the template", () => {
  const readme = read("README.md");
  assert.match(readme, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.doesNotMatch(readme, /types: \[opened, synchronize, reopened, edited, ready_for_review\]/);
  assert.match(readme, /ci-retarget\.yml/);
});

// gantry#125: drafts run nothing, and leaving draft runs CI once. The two halves
// only work together: a draft skip without ready_for_review would leave a PR
// that left draft with no ci-ok until its next push.
test("template ci caller skips drafts and runs on ready_for_review", () => {
  assert.ok(types(caller).includes("ready_for_review"));
  assert.match(caller, /^ {4}if: \$\{\{ !github\.event\.pull_request\.draft \}\}$/m);
});
