# gantry

**The frame the robots build in.** Most of the code in my repos is written by
Claude. gantry is the set of automatic checks around that code: one shared
setup, so every repo gets the same guardrails without copying anything.

Written instructions only go so far: an agent under pressure will add `as any`,
skip a test or commit a key. gantry's answer is checks that *run*, at three
levels, each harder to get around than the last:

| Layer | Where | Can it be skipped? |
|---|---|---|
| **CLAUDE.md** | the repo | Easily: it's guidance the agent reads |
| **Local hooks** | your machine, on commit and push | Only with `--no-verify`, which is banned |
| **CI** | GitHub, on every PR | No |

## How signals, gantry, shinstack and shinfactory fit together

Each of the four works alone. When they are used together, they do not overlap.

| Tool | Answers | Owns | How it acts |
|---|---|---|---|
| [signals](https://github.com/guangshinhaha/signals) | What outside fact becomes a task, and did the fix hold? | Events from a live product, the cause that groups them, the task it opens, and the confirm after a release | An agent reads and writes an API |
| [gantry](https://github.com/guangshinhaha/gantry) | Did it pass? | Local hooks, CI checks, the secret scan and the required `gantry / ci-ok` check | Runs checks with no judgment, and can block a merge |
| [shinstack](https://github.com/guangshinhaha/shinstack) | How should the agent work, and may it act? | Principles, playbooks, review depth, PR format and approval modes | Advises the agent |
| [shinfactory](https://github.com/guangshinhaha/shinfactory) | What runs next, and who runs it? | Stage order, retries, provider and model, and merges inside a factory order | Runs the loop once a task exists |

To place a new rule, ask these in order and stop at the first yes:

1. Is it a fact from a live product (feedback, an exception, a release), or a check that the cause went quiet after a release? It goes in signals.
2. Can a machine check it with no judgment? It goes in gantry. A check that only one repo needs goes in that repo's own workflow.
3. Does it need a schedule, a stage, or an event inside a factory order that already has a task? It goes in shinfactory.
4. Would it still apply to one person running one agent session with no loop? It goes in shinstack.

Signals opens the task and stops. shinfactory decides when that task runs and which agent runs it. gantry decides whether the checks pass. shinstack tells the agent how to work, and its `approval-modes` or shinfactory's `mode` decides whether a merge may happen. A merge still needs both a green check and an approval.

Full reasoning: [the decision record](https://github.com/guangshinhaha/shinstack/blob/main/docs/decisions/shinstack-vs-shinfactory.md).

## What runs when

**On every commit** (fast, staged files only)
- **Secret scan** (gitleaks): flags a key written in a form gitleaks' rules recognise. It misses some forms; see [Secret scan](#secret-scan).
- **No escape hatches:** blocks newly added `any`, `as any`, `@ts-ignore` and
  `eslint-disable`, the usual ways to make an error disappear instead of fixing it.
- **ESLint** on the staged files, if the repo uses ESLint.

**On every push**
- **Format check** (`format:check`, if the repo has it), **typecheck** (`tsc --noEmit`), **unit tests**, and a **dependency audit**
  (high severity and above, production dependencies only).

**On every pull request** (GitHub Actions)
- The same checks again on a clean machine: secrets, lint (`lint:ci` if defined, else `lint`), format check, typecheck, tests, audit.
  Every check runs even if an earlier one fails, so one push shows all failures. A failed install still stops the job.
- **Mutation testing** on the files the PR changed (see below). Survivors are
  posted as a PR comment.
- **`needs-human` label** when the PR touches a risky path (auth, migrations,
  payments, API keys, RLS). See below.
- Optional (`--ac-check`): **Acceptance criteria.** If the PR says `Closes #N` and issue N has an
  `Acceptance criteria` checklist, the PR body must repeat it with every item
  ticked (and evidence). Unticked items fail the check, named; editing the
  body re-runs it. Fewer items than the issue only warns. Skips drafts and PRs
  with no such issue. Off by default: it can only see that a box is ticked, not
  that the claim is true. A repo that already has the workflow keeps it.
- Optional: Playwright end-to-end tests.
- **Preview smoke tests** (Railway or Vercel): once the PR's preview is live on the PR's
  latest commit, Playwright `@smoke` tests run against it. Screenshots are
  uploaded and one PR comment (updated on every push) shows pass or fail. See
  below.
- Optional: **Lighthouse scan** of the preview (scores and top failing
  audits in the same PR comment). See below.
- The secret scan checks only the PR's own commits, so a key on another branch
  or in old history can't turn an unrelated PR red. A push that isn't a merged
  PR scans the pushed commits. A PR can't loosen the scan for itself; see
  [Secret scan](#secret-scan).
- **A push that is a merged PR skips every job**, but only when a PR merged
  into the pushed branch and its head had a green `ci-ok`. A PR merged into
  another branch, or one whose CI was red (an admin merge, or a re-run of the
  red push), runs the checks. Reading the PR's checks needs no extra
  permission on a public repo. A private repo's caller must grant
  `checks: read`, or the skip never fires and every push runs the checks. The
  docs-only push skip reads the previous head's `ci-ok` the same way (gantry#110),
  so it needs `checks: read` on a private repo too.
- **A retargeted PR re-runs `ci`.** The template caller listens for `edited`,
  the only event GitHub sends when a PR's base changes. An edit that leaves the
  base alone (title, body) skips the caller's job and can't cancel a run in
  flight. The caller's trigger is:

  ```yaml
  on:
    push:
      branches: [main]
    pull_request:
      types: [opened, synchronize, reopened, edited]
  ```

  A caller copied before this has no `edited`: add the `types:` line, the
  `if:` and the `group:` suffix from `template/.github/workflows/ci.yml`.
- **Docs-only changes** always run the secret scan, because a key can be
  pasted into a doc. They skip the other checks above inside the job, so the
  status still reports instead of sitting on "pending". A change is docs-only
  when every file is a `*.md`, or an image, PDF or text file (`.png`, `.jpg`,
  `.svg`, `.pdf`, `.txt` and similar) under `docs/`. Any other file under
  `docs/` counts as code, so a script, `.json`, `.yml` or `.mdx` there runs the
  checks. It is judged by path, never by what the file is or what reads it. A
  `*.md` counts as docs wherever it is, even if code reads it, such as a prompt
  file. So does a docs file that code reaches through a symlink: if `src/rate.ts`
  is a symlink to `docs/rate.md`, a change to only `docs/rate.md` skips the
  checks. Don't link code to a docs file. A renamed file counts under both its
  old and new name. When the file list may be cut off (a PR whose list is
  shorter than its changed-file count, or a push of 300 or more files), the
  change is not docs-only. A push is docs-only only if it is a fast-forward of
  the branch's previous tip: after a force-push the list of changes can't show
  the code the old and new tips share, so the checks run.
- **`gantry / ci-ok`**: one summary check. It fails if any job failed or was
  cancelled; skipped jobs count as passing. This is the check to require.
- Optional: **second review by Claude** (see below). Runs once when a PR opens
  or leaves draft, then only on request.
- Optional (`--docker`): **Docker build**. PRs and `main` build the
  `Dockerfile` with the GHA cache to catch breakage. It never pushes: GovPaaS
  (Northflank), Railway and Vercel build the image themselves, and only AWS
  apps push to ECR. A registry push may come back later as an opt-in. Without
  a Dockerfile it skips and says so (`Skipped: no Dockerfile`) in the job
  summary. Add `run-image: true` to also run the image and probe it (see
  [Docker smoke test](#docker-smoke-test-opt-in)).

**Once a day** (GitHub Actions, `secrets-scan.yml`)
- **Secret scan of every branch and all history.** It never blocks a PR. A leak
  turns the run red and opens one issue titled `gantry: the daily secret scan failed`,
  or comments on it if it's still open. It's an issue, not just the red run, because
  GitHub emails a scheduled run's failure only to whoever last changed its cron
  line, and turns schedules off after 60 days without activity in a public repo.
  The issue reaches everyone watching the repo. Run it by hand from the Actions tab.
- An existing repo adds it by copying
  [`template/.github/workflows/secrets-scan.yml`](template/.github/workflows/secrets-scan.yml)
  to `.github/workflows/secrets-scan.yml` (or re-running `gantry-init`, which
  keeps every file that exists). The caller must grant `contents: read` and
  `issues: write`.

**Optional extras** for some stacks
- `prisma`: blocks raw-SQL escape hatches (`$queryRawUnsafe`, `Prisma.raw()`);
  checks the Dockerfile copies the Prisma schema.
- `nextjs`: blocks database or API calls at build time; runs Playwright on push
  when app code changed.

Every check skips itself when a repo doesn't have the relevant script or
config, so it is safe to turn everything on everywhere. One exception: a repo
with a `package.json` only in a subfolder fails the node job until you move
the project to the root or set `node: false` (see below).

## Repos that aren't plain Node

`ci.yml` has a `node` job for lint, format check, typecheck, tests and audit.
`gantry / ci-ok` stays green when the job skips, and the run's summary says why
(`Node checks skipped: <reason>`). The secret scan still runs and still counts.

- **No `package.json`** (a repo in any other language): the job skips with no
  setting needed.
- **`package.json` only in a subfolder** (such as `app/package.json`): the job
  fails, because it only runs at the repo root and skipping would let a broken
  project pass. Move the project to the root, or set `node: false` and run its
  checks in your own workflow.
- **A `package.json` in a repo with its own test workflow:** set `node: false`.
  Use it when gantry's job can't run the repo's checks, such as shinfactory,
  whose `test` script is `go test ./...` and needs the UI built first.

```yaml
jobs:
  gantry:
    uses: guangshinhaha/gantry/.github/workflows/ci.yml@main
    permissions:
      contents: read
      pull-requests: read
    with:
      node: false
```

`gantry / ci-ok` doesn't cover the repo's own workflow, so a repo that sets
`node: false` also needs that workflow's job required with `gantry-protect
--require` (see [Blocking merges on red CI](#blocking-merges-on-red-ci)).

## Generated code is up to date

Set `codegen-command` and the node job runs it after install, then fails if it
changed or added any file git would commit: the committed generated files are
stale. The error and the run's summary list each changed file. Without the
input the step skips and the summary says `Skipped: no codegen-command given`.

```yaml
    with:
      codegen-command: pnpm prisma generate   # or: make generate
```

It lives in the node job, right after install and before lint and tests, so it
needs a root `package.json` and `node` left on, and a docs-only change skips it
with the rest. When the job skips because the repo has no `package.json` or the
caller set `node: false`, the summary says `codegen-command did not run`.
The command runs under `bash -eo pipefail`, so the first failing command fails
the step. The tree is compared with `HEAD`, so a file an install hook already
regenerated still counts as stale. Gitignored output isn't checked, since it
isn't committed.

## Blocking merges on red CI

CI alone doesn't stop a merge. To make `gantry / ci-ok` required on a repo's
default branch (repo admins can bypass), run once per repo:

```sh
~/Desktop/projects/gantry/bin/gantry-protect owner/repo [--dry-run] [--require <check>]... [--no-ci-ok]
```

It creates a ruleset named `gantry`, or updates it if it exists.
`--dry-run` prints the JSON payload and changes nothing. It needs `gh` signed
in as a repo admin.

- **`--require <check>`** adds a required check. Repeat it for more checks.
  `gantry / ci-ok` stays required.
- **`--no-ci-ok`** leaves out `gantry / ci-ok`, for a repo without gantry's CI,
  where that check would never report. It needs at least one `--require`.
- **Each run replaces the list.** Pass every check you want each time. A real
  run prints the final list.

`gantry / ci-ok` covers only the jobs in gantry's `ci.yml`. The other workflows
report their own checks:

| Workflow | Check | Require it? |
|---|---|---|
| `ci.yml` | `gantry / ci-ok` | Yes, by default. |
| `risky-paths.yml` | `risky-paths / risky-paths` | Optional, with `--require`. It fails only if the job breaks, because a matching path adds a label and doesn't fail the check. |
| `ac-check.yml` | `ac-check / ac-check` | With `--require`, on repos that opted in with `--ac-check`. |
| `verdict-check.yml` | `verdict-check / verdict-check` | Optional, with `--require`. It skips PRs without the high-risk label, and a skipped required check counts as passing. |
| `build.yml` | `build / build` | No. It doesn't run on docs-only PRs, so they would wait forever. |
| `review.yml` | `review / review` | No. It runs only on some PR events. |
| `mutation.yml` | `mutation / mutation` | No. It doesn't run on docs-only PRs, so they would wait forever. |
| `preview.yml` | `preview / preview` | No. It doesn't run on docs-only PRs, so they would wait forever. |

A check name must match what GitHub reports. A name that never reports leaves
every merge waiting, so look it up from a recent run before applying:

```sh
gh api repos/owner/repo/commits/<sha>/check-runs --jq '.check_runs[].name'
```

A ruleset that requires a check also blocks direct pushes to the default branch.
Repo admins keep their bypass, so they can still push and merge.

- **Plan:** rulesets and protected branches on *private* repos need a paid
  GitHub plan (Pro, Team or Enterprise). Free covers public repos only. GitHub's
  docs are vague on per-plan detail, so check the repo's plan before relying on it.
- **Railway:** turn on "Wait for CI" by hand, per service (Service Settings,
  Source/Deploy). Otherwise Railway deploys before CI finishes. It can't be set
  from this repo.

## Mutation testing

Code coverage says which lines your tests *run*. Mutation testing checks
whether the tests would *notice if those lines were wrong*.

[Stryker](https://stryker-mutator.io) makes small deliberate bugs ("mutants")
in your code and reruns the tests for each one:

```
if (used >= cap)   →   if (used > cap)
a && b             →   a || b
await audit.log()  →   (removed)
```

If a test fails, the mutant is **killed**. If every test still passes, it
**survived**: that behaviour is untested. The PR comment lists each survivor:

> **Mutation score 88.1%** (74/84 killed, 4 files)
>
> - `src/lib/div-rep-quota.ts:64` ConditionalExpression: `const isThisMonth = … && …` → `true`

That one was real: on sums, no test checked that last month's studies don't
count towards this month's quota.

**Fixing survivors:** ask Claude to "kill the survivors on PR #N". It adds or
tightens tests until each mutant fails one. It never changes app code just to
kill a mutant. If a change makes no real difference, it marks the line
`// Stryker disable next-line <Mutator>: <reason>`.

**Keeping it cheap**
- Only the files the PR changed are mutated, never the whole repo.
- Each mutant runs only the tests that cover it.
- Results are cached between pushes; stale runs are cancelled; drafts are skipped.
- A hard 15-minute cap. Public repos don't use Actions minutes at all.

It's on by default for Vitest and Jest repos. It's off for node:test (too slow
under Stryker), Vitest 1 (Stryker's runner needs Vitest 2+), monorepos and
repos without tests. If the Stryker install fails, or resolves Vitest 1
anyway, gantry-init puts package.json back, warns, leaves mutation testing off
and carries on. It reports only and never blocks a merge, unless you set
`thresholds.break` in `stryker.config.mjs`.
Two cases stay green and are explained in the comment: changed files that no
test covers (it names them), and existing tests that already fail (mutation
testing is skipped; the test job reports the failures). Only a real miss of
`thresholds.break` turns the check red.

## Docker smoke test (opt-in)

`build.yml` only builds the image by default. Turn on `run-image` and it also
loads the image, runs it, waits for health, and checks the probes you declare.
Use it when "the image builds" isn't enough: a container that starts and
crashes, a missing route, a static file served with the wrong status.

```yaml
jobs:
  build:
    uses: guangshinhaha/gantry/.github/workflows/build.yml@main
    with:
      run-image: true
      port: 3000            # the port the container listens on (also passed as PORT)
      health-path: /health  # must answer 2xx within health-timeout seconds
      probes: |             # optional, one per line: <path> [expected status]
        / 200
        /missing.js 404
    permissions:
      contents: read
```

| Input | Default | Meaning |
|---|---|---|
| `run-image` | `false` | Off unless you set it. With it off, the job is unchanged. |
| `port` | `3000` | Container port, published on the same port of the runner. |
| `health-path` | `/health` | Polled until it answers 2xx. |
| `probes` | none | Extra `GET` checks. The status defaults to `200`. Blank lines and `#` lines are ignored. |
| `health-timeout` | `60` | Seconds to wait for health before failing. |

`run-image` needs a single `platforms` value (the default `linux/amd64` is fine),
because Docker can only load one platform into the runner. It must also match
the runner's architecture, or the container dies with an exec format error.
The container is published on `127.0.0.1` only.

**When it fails.** The job goes red and each failure is an error annotation, and
a line in the job summary, that names the probe, for example
`GET /missing.js expected 200, got 404`, or
`health GET /health: no 2xx within 60s (last status 500)`, or
`health GET /health: the container exited before it answered`. A bad extra probe
doesn't stop the others: one run lists every failed probe. The last 50 lines of
the container log follow. A health failure stops there, since the app isn't up.

**Limits.** It sends `GET` only, and it doesn't pass secrets or env vars to the
container beyond `PORT`, so an app that needs a database or keys to start
won't pass health. The preview smoke tests below cover a deployed app.

## Preview smoke tests

CI tests the code; this tests the deployed app. For each PR, `preview.yml`
finds the Railway preview URL through the Railway API (the GitHub deployment
URL only points at the dashboard), waits until the deployment is `SUCCESS` on
the PR head commit and answers HTTP 200, then runs
`npx playwright test --grep @smoke` with `BASE_URL` set to it. If the preview
never comes up, or is stuck on an older commit, the job fails after
`timeout-minutes` (default 10) and the PR comment says why.

**Setup, per repo**
1. In Railway, enable PR environments (Project Settings, Environments) and make
   sure the service has a public domain.
2. Add a `RAILWAY_TOKEN` repo secret. A project token works if it covers the
   PR environments; otherwise use an account/workspace token and pass
   `railway-project-id` in the caller's `with:`.
3. Tag the tests worth running on every PR `@smoke`
   (`test('home loads @smoke', ...)`) and set `use: { screenshot: 'on' }` in
   `playwright.config.ts` so there are screenshots to post.
4. `gantry-init` adds `.github/workflows/preview.yml` only when it finds
   `railway.json`/`railway.toml` (railway) or `vercel.json`/`.vercel` (vercel), and writes
   that platform into the caller. Otherwise it prints a skip line; add it with
   `gantry-init --preview railway` (or `vercel`). There is no default platform.

Without the secret (including PRs from forks) or without `@smoke` tests, the
job skips itself and says why: `Skipped: <reason>` in the job summary plus a
notice annotation on the run, so a green check is never silent. Inputs: `platform` (required), `smoke-command`, `timeout-minutes`,
`railway-project-id`, `railway-service`.

**Vercel** (`platform: vercel`): no token needed. The job reads the GitHub
deployment status Vercel creates for the PR head commit, waits for `success`,
and uses its `environment_url`. Everything after that (200 check, Playwright,
screenshots, comment) is the same as Railway. Fork PRs are skipped. The caller
needs `deployments: read` (the template has it).

If Deployment Protection is on, add the `VERCEL_AUTOMATION_BYPASS_SECRET` repo
secret (the project's Protection Bypass for Automation value). gantry sends it
as the `x-vercel-protection-bypass` header on the 200 check, and passes it to
Playwright as the env var of the same name. Playwright needs the header in
`playwright.config.ts`:

```ts
use: { extraHTTPHeaders: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {} }
```

**Lighthouse (optional, off by default).** Set `lighthouse: true` in the
caller's `with:` and, once the smoke tests pass, `@lhci/cli` scans the preview
and adds a table of Performance, Accessibility, Best practices and SEO scores,
plus the top failing audits, to the same PR comment. HTML reports are in the
**preview-lighthouse** artifact. `lighthouse-urls` is a space or newline
separated list of paths (default `/`). It reports only, unless you set
`lighthouse-min-a11y` (0-100): the job then fails when any scanned page scores
lower on accessibility. It needs the same preview URL as the smoke tests, so
it skips whenever they do.

## Verdict check

A high-risk PR shouldn't merge on green CI alone. Opt in by calling
`verdict-check.yml` from a repo workflow:

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, labeled, unlabeled]
  issue_comment:
    types: [created, edited, deleted]
jobs:
  verdict-check:
    permissions: { actions: write, contents: read, issues: read, pull-requests: read }
    uses: guangshinhaha/gantry/.github/workflows/verdict-check.yml@main
    # with:
    #   label: risk:high                              # default
    #   trusted-associations: OWNER,MEMBER,COLLABORATOR   # default
```

A PR with the label (default `risk:high`) fails until a PR comment holds a
verdict, as JSON, with `verdict` `PASS` or `PASS+NOTES` and a `head_sha` equal
to the PR's current head. Without the label the check skips.

```json
{"pr": 12, "head_sha": "<full 40-character sha>", "verdict": "PASS", "evidence": ["node --test: 41 pass"]}
```

- A push moves the head, so it needs a new verdict.
- A `FAIL` verdict at the head that is newer than every `PASS` at the head fails the check.
- Only comments from `OWNER`, `MEMBER` or `COLLABORATOR` count. A `pr` field that names another PR is ignored.
- Posting, editing or deleting a comment that mentions `verdict` re-runs the PR's runs of the calling workflow at its head (a PR opened with the label has one per event; a run still going is waited for first), so the check turns green or red by itself. `gantry-init --verdict-check` adds a caller that does this. The caller must be on the default branch, because comment events run there, and it needs `actions: write` for the re-run. A caller without `actions: write` fails to start (`startup_failure`) on every event, so its check never reports: add the permission when upgrading an older caller. Without `issue_comment` in the caller, re-run by hand (`gh run rerun <id>`).
- The check still shows its earlier result until the re-run starts, a few seconds after the comment. Don't merge in that gap.
- It checks that a verdict exists, not that it is right or independent: the author can post their own `PASS` if they hold one of those roles. Who sets the label is up to you.

### Label High-risk PRs automatically

A label someone forgot to set means no check. `risk-label.yml` adds `risk:high`
to a PR that changes a High-risk path, so verdict-check can't be skipped that
way. `gantry-init --verdict-check` writes both jobs; in an existing caller, add
the `risk-label` job and `needs` as in the template:

```yaml
jobs:
  risk-label:
    if: ${{ github.event_name == 'pull_request' }}
    permissions: { contents: read, pull-requests: write }
    uses: guangshinhaha/gantry/.github/workflows/risk-label.yml@main
  verdict-check:
    needs: risk-label
    if: ${{ !cancelled() }}
    with:
      risk-label-result: ${{ needs.risk-label.result }}
    permissions: { actions: write, contents: read, issues: read, pull-requests: read }
    uses: guangshinhaha/gantry/.github/workflows/verdict-check.yml@main
```

- **Paths.** Always `.github/workflows/**`, `template/.github/**` and
  `bin/gantry-protect`. A repo adds its own in `.github/gantry-high-risk-paths`
  (one glob per line, `#` for comments, same globs as the risky-paths list), for
  example `loop/**` and `dispatcher/**`. The file can add paths, not remove a
  default. It is read from the **base branch**, so a PR can't empty it; a new list
  applies once merged.
- **Order.** verdict-check needs the `risk-label` job, and reads the PR's live
  labels (a label added with the workflow token starts no new run, and the event
  payload predates it). A caller without the `risk-label` job works as before.
- **It only adds.** A label a person set stays, and so does one added here after
  the PR stops matching, until a person removes it. Removing it doesn't re-run the
  labelling (the `unlabeled` event for that label is skipped). If the job fails,
  verdict-check fails with it (`risk-label-result`), so a missed label never
  passes as a skip.
- **Fork and Dependabot PRs.** Their token is read-only (Dependabot's even on a
  same-repo branch), so they can't be labelled. If one touches a High-risk path the
  job fails until a maintainer adds the label by hand; once it is there, the job
  passes.
- **Pinned scripts.** The matching scripts run with a write token, so
  `risk-label` downloads them at `gantry-ref`, which must be a full 40-character
  commit sha (a branch or tag name is refused). The default is a pinned sha,
  bumped when the scripts change; gantry's own CI runs
  `scripts/check-risk-label-pin.mjs` on the default branch and fails when the pin
  is behind. gantry's own caller passes the PR's base sha,
  so a PR that edits the matcher is labelled by the old one.
- **One label name.** If you set `label:` on verdict-check, pass the same `label:`
  to `risk-label`.
- **Big PRs.** A PR of 3000+ files (the API's cap; renames count once) is
  labelled, since the file list may be cut short.
- **Errors show.** A failed label create is ignored only if the label exists
  afterwards; any other failure fails the job. The label is added through the REST labels
  endpoint, which the workflow token accepts.
- The `verdict-check / verdict-check` job now runs on every PR and skips inside
  the script when there is no label, instead of being skipped by the workflow.

## Secret scan

The `secrets` job in `ci.yml` runs gitleaks (v8.30.1, default rules) over the
commits the run adds. The local hook runs the same tool on staged files, and
`secrets-scan.yml` scans every branch once a day.

**What it catches.** What gitleaks' rules match, and that is narrower than "any
key". In docs, the generic rule needs the `name = "value"` shape. These pass,
though the same key is flagged in that shape:
- a key in a Markdown table, in prose (`The staging API key is ...`) or in bold
  (`**API key:** ...`);
- a file saved as UTF-16, which git treats as binary;
- a file under a path gitleaks' default rules skip, such as lock files, `node_modules`, `go.sum` and `.svg`;
- a key with low entropy: about 1 in 6 random 32-character hex keys pass.

Treat a green scan as "no key in a form gitleaks knows", not "no key".

**Merge commits.** A merge commit is scanned for what it adds beyond an
automatic merge of its parents (`--diff-merges=remerge`), so a key added while
resolving a conflict, or in an evil merge, fails the scan. A clean merge adds
nothing, so main merged back into a PR branch doesn't bring main's history into
the scan. Git skips this for octopus merges (three or more parents), so a key added only in one isn't seen. The daily scan doesn't read merge commits this way.

**What a PR can't change for itself.** The scan runs with the base branch's
`.gitleaks.toml` and `.gitleaksignore` (gitleaks' default rules if the base has
none), the base's `.gitattributes` (so a `-diff` line can't hide a file), and
with `gitleaks:allow` comments ignored. A PR that changes a `.gitleaks.toml`
or `.gitleaksignore` anywhere in the repo, or adds a line containing
`gitleaks:allow` (a doc that mentions it counts), fails the `secrets` job until
a person approves it:
- the approver must be the repo's owner, a member or a collaborator (GitHub's
  association on the review) and not the PR's author;
- the approval must be on the PR's current head, so a later push needs a new one;
- after approving, re-run the `secrets` job. The PR's own config, ignore file
  and allow comments then apply, which is how a real false positive gets
  allowlisted. Once merged, the change is the base's, and later PRs use it.

A repo with one person has no approver. Land such a change with an admin's direct push or branch-protection bypass.

**Needs.** git 2.40 or newer (older fails the job with a message), and `gh`
and `jq` on the runner (GitHub-hosted runners have both). A base
`.gitleaks.toml` may extend a file by relative path (`[extend] path`); the scan
then reads that file from the base, not from the PR.

## Risky paths

Some changes deserve a human look however green CI is. List the paths in
`.github/gantry-risky-paths` (one glob per line, `#` for comments):

```
**/auth/**
**/migrations/**
prisma/schema.prisma
```

When a PR changes a matching file, gantry adds the `needs-human` label (creating
it if missing) and keeps one comment listing the matched files and which glob
hit. When the PR no longer matches, the label and comment are removed.

- The list is read from the **base branch**, so a PR can't switch the check off
  by editing it. A new list takes effect once it is merged.
- Off when the file is absent. `gantry-init` copies a commented example.
- **Same-repo PRs only.** Fork PRs get a read-only token and can't be labelled
  or commented on, so the check skips them.
- It labels only; it doesn't block merging.

## Second review (opt-in)

Most code here is written by Claude and reviewed by one tired human. This adds
a second reviewer: [claude-code-action](https://github.com/anthropics/claude-code-action)
reads the PR diff and posts inline comments, ranked (correctness first, no
style nits). It follows the repo's `CLAUDE.md` review rules if there are any.

> **PDPA: this sends PR diffs to Anthropic.** Don't enable it on a repo whose
> diffs could contain real student, staff or citizen data (fixtures, seeds,
> screenshots). Decide per repo. That is why `gantry-init` does not add it
> unless you pass `--review`.

**Setup:** run `gantry-init --review` (or copy `template/.github/workflows/review.yml`),
then add the `ANTHROPIC_API_KEY` repo secret yourself. Without the secret the
job skips itself.

**When it runs**
- Once when a PR is opened or marked ready for review. Not on every push.
- On demand: add the `review` label (it is removed afterwards, so you can add
  it again) or comment `@claude review` (owners, members and collaborators only).
- Never on drafts, bot PRs or fork PRs.

**Cost:** about $0.10 to $0.50 per review on the default `claude-sonnet-5-5`
($2 / $10 per million input / output tokens; estimate for a typical PR, not
measured). `--max-turns` (default 12) caps the worst case. Both are inputs on
the caller: `model:` (e.g. `claude-haiku-5-5` for cheaper) and `max-turns:`.
Like the other checks, it reports only and never blocks a merge.

## Using it

**New repo:** in Claude Code, run `/new-repo <git link>`. It clones the repo,
applies gantry, writes a starting CLAUDE.md, and asks before pushing.

**Existing repo:**

```sh
~/Desktop/projects/gantry/bin/gantry-init [dir] [--prisma] [--nextjs] [--no-mutation] [--review] [--docker] [--ac-check] [--verdict-check]
git add -A && git commit -m "Add gantry checks"
```

`gantry-init` never overwrites a file that already exists, and is safe to run
again. If the repo uses oxfmt, biome or prettier, it formats the files it adds,
and no others, with the repo's local binary. It adds:

| File | What it is |
|---|---|
| `lefthook.yml` | Local hooks. Points at this repo, so updates arrive automatically (re-fetched daily). |
| `.github/workflows/ci.yml` | A few lines that call gantry's shared CI. |
| `.github/workflows/secrets-scan.yml` | A few lines that call gantry's daily secret scan of every branch. |
| `.github/workflows/mutation.yml` | A few lines that call gantry's mutation testing. |
| `.github/workflows/preview.yml` | A few lines that call gantry's preview smoke tests. |
| `.github/workflows/risky-paths.yml` | A few lines that call gantry's `needs-human` labelling. |
| `.github/gantry-risky-paths` | Example list of risky globs. Edit to fit the repo. |
| `.github/workflows/review.yml` | Second review by Claude. Only with `--review`. |
| `.github/workflows/ac-check.yml` | Only with `--ac-check`: calls gantry's acceptance-criteria check. Kept if it already exists. |
| `.github/workflows/verdict-check.yml` | Only with `--verdict-check`: calls gantry's verdict check, which also re-runs when a verdict comment is posted, and a `risk-label` job that adds `risk:high` for High-risk paths (a repo's own go in `.github/gantry-high-risk-paths`). Kept if it already exists. It blocks a merge only once `verdict-check / verdict-check` is a required check. |
| `.github/pull_request_template.md` | PR template: `Closes #`, how I verified. With `--ac-check`, or if the repo already has `ac-check.yml`, it also has an acceptance criteria section. |
| `stryker.config.mjs` | Stryker config, with the repo's test runner detected. |
| `.github/workflows/build.yml` | Only with `--docker`: calls gantry's build-and-verify Docker build (no push). |
| `CLAUDE.md` | A starting template: commands, gates, review rules. |

Repos that use husky are left alone, with instructions for switching.

**Repo-specific checks** go in that repo's own `lefthook.yml` or workflow.
When one turns out to be useful everywhere, move it here.

## How it's built

```
hooks/          lefthook configs: base (every repo), node, prisma, nextjs
.github/workflows/
  ci.yml        shared CI that repos call: gate (merged-PR skip; docs-only runs
                secrets only; no package.json or `node: false` skips node,
                a package.json only in a subfolder fails it),
                secrets, node, then ci-ok (the one required check)
  secrets-scan.yml  shared daily scan of every branch and all history; opens
                an issue on a leak, never blocks a PR
  mutation.yml  shared mutation testing that repos call
  preview.yml   shared preview smoke tests. Platform-neutral; the only
                platform-specific part is one "Find preview URL" step per platform.
                Optional Lighthouse step runs after smoke.
  risky-paths.yml  shared needs-human labelling that repos call
  review.yml    shared second review (claude-code-action) that repos call
  ac-check.yml  shared acceptance-criteria check (opt-in via --ac-check)
  verdict-check.yml  shared check that a high-risk PR has a verdict at its head (opt-in)
  risk-label.yml  shared risk:high labelling for High-risk paths, ahead of verdict-check (opt-in)
  build.yml     shared Docker build-and-verify, no push (opt-in via --docker)
  own-ci.yml    gantry's own check on PRs and main: actionlint, template callers against
                the shared workflows' inputs, commented-out options included
                (scripts/lint-template-calls.sh), hook YAML via lefthook validate, script syntax, node --test; repos don't call it
  selftest.yml  on gantry PRs that change ci.yml, runs that ci.yml on sample PRs in
                gantry-sandbox and fails if a check stopped firing; repos don't call it
template/       files gantry-init copies into a repo
bin/gantry-init sets a repo up
bin/gantry-protect requires gantry / ci-ok, plus any --require, on the default branch (ruleset)
scripts/        mutation-report.mjs: turns Stryker's results into the PR comment
                preview-railway.mjs: Railway adapter, finds and checks the preview URL
                preview-vercel.mjs: Vercel adapter, reads the GitHub deployment status
                lighthouse-report.mjs: turns Lighthouse results into the PR comment section
                risky-paths.mjs: glob matching for needs-human (tests in scripts/test/)
                high-risk-paths.mjs: default and per-repo High-risk globs for risk:high
                check-risk-label-pin.mjs: flags a stale default gantry-ref in risk-label.yml
                ac-check.mjs: parses PR/issue checklists (tests: ac-check.test.mjs)
                verdict-check.mjs: finds the verdict at a PR's head (tests in scripts/test/)
                verdict-rerun.mjs: re-runs a PR's verdict-check on a verdict comment (tests in scripts/test/)
                selftest.mjs: the sandbox self-test that selftest.yml runs
```

Repos follow `main`, so a change here reaches every repo at once: the hooks on
their next daily re-fetch, CI on their next run. Test changes on one repo first.

A PR that changes `ci.yml` gets the `gantry-selftest` check. It opens four draft
PRs in gantry-sandbox against that PR's `ci.yml`: a normal change (must go green),
a failing test and a made-up key planted in `docs/` (both must turn `gantry / ci-ok` red),
and a docs-only change (must run the secret scan and skip node). It closes them
and deletes their branches when done. To run it from your machine, signed in to
`gh`: `node scripts/selftest.mjs --gantry-sha <pushed sha>`. Don't run two at
once: each run's cleanup removes every `selftest/` branch.

To run CI on your own machine instead of GitHub's, pass
`runs-on: '["self-hosted","gantry"]'` in a repo's `ci.yml`.
The secret scan downloads gitleaks for Linux and macOS on x64 or arm64. On any
other runner it fails with "unsupported platform" unless gitleaks is already on
the runner's PATH, which it then uses.

## Next

See the [open issues](https://github.com/guangshinhaha/gantry/issues). Ideas not yet scoped
have the `idea` label; work waiting on something outside the repo has `blocked`.
