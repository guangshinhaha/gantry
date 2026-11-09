// The wiring that makes the label land before verdict-check looks, which node
// can't run: workflow text is checked for the lines that carry that ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const callers = {
  template: read("template/.github/workflows/verdict-check.yml"),
  own: read(".github/workflows/verdict-check-caller.yml"),
};

for (const [name, wf] of Object.entries(callers)) {
  test(`${name} caller: verdict-check waits for risk-label and still runs when it is skipped`, () => {
    const job = wf.split(/^  verdict-check:\n/m)[1];
    assert.match(job, /^    needs: risk-label$/m);
    assert.match(job, /^    if: \$\{\{ !cancelled\(\) \}\}$/m);
    assert.match(job, /risk-label-result: \$\{\{ needs\.risk-label\.result \}\}/);
  });
  test(`${name} caller: risk-label runs on PR events only and can write labels`, () => {
    const job = wf.split(/^  risk-label:\n/m)[1].split(/^  verdict-check:/m)[0];
    assert.match(job, /if: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    assert.match(job, /pull-requests: write/);
  });
}

test("verdict-check does not trust the event payload's labels, which predate risk-label", () => {
  const wf = read(".github/workflows/verdict-check.yml");
  const jobIf = wf.match(/^  verdict-check:\n(?:    #.*\n)*    if: (.*)$/m)[1];
  assert.doesNotMatch(jobIf, /labels/);
});

test("verdict-check fails when risk-label failed or was cancelled, so a missed label can't pass as a skip", () => {
  const wf = read(".github/workflows/verdict-check.yml");
  assert.match(wf, /if: \$\{\{ contains\(fromJSON\('\["failure","cancelled"\]'\), inputs\.risk-label-result\) \}\}\n\s+run: \|\n[^]*?exit 1/);
});

test("risk-label only adds the label: it never removes one a person set", () => {
  const wf = read(".github/workflows/risk-label.yml");
  assert.match(wf, /--add-label/);
  assert.doesNotMatch(wf, /--remove-label/);
});

test("risk-label reads the repo's list from the base commit", () => {
  const wf = read(".github/workflows/risk-label.yml");
  assert.match(wf, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
});

test("risk-label fails a fork PR that touches a High-risk path instead of passing it unlabelled", () => {
  const wf = read(".github/workflows/risk-label.yml");
  assert.match(wf, /if \[ "\$FORK" = "true" \]; then\n[^]*?exit 1/);
  assert.doesNotMatch(wf, /Skipped: fork/);
});

test("risk-label keeps a label the repo already customised", () => {
  const wf = read(".github/workflows/risk-label.yml");
  assert.doesNotMatch(wf, /label create[^\n]*--force/);
});
