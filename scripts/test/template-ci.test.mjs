// The ci caller that gantry-init copies must re-run on a PR's base change
// (gantry#65): the `edited` event is the only one GitHub fires for a retarget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const caller = read("template/.github/workflows/ci.yml");

test("template ci caller listens for edited, so a retarget re-runs ci", () => {
  assert.match(caller, /pull_request:\s*\n\s*types:\s*\[[^\]]*\bedited\b[^\]]*\]/);
  // Setting `types` drops the defaults, so they must be listed again.
  for (const t of ["opened", "synchronize", "reopened"]) assert.match(caller, new RegExp(`types:\\s*\\[[^\\]]*\\b${t}\\b`));
});

test("template ci caller skips an edit that leaves the base alone, without cancelling a run", () => {
  // Skipped at the caller, so no new `ci-ok` goes green over a red one.
  assert.match(caller, /if:.*github\.event\.action != 'edited'.*github\.event\.changes\.base/);
  // The concurrency group differs for such an edit, so it can't cancel the PR's real run.
  assert.match(caller, /group:.*github\.event\.changes\.base.*github\.run_id/);
});

test("the README's ci caller snippet matches the template", () => {
  assert.match(read("README.md"), /types: \[opened, synchronize, reopened, edited\]/);
});
