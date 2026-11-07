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

## How gantry, shinstack and shinfactory fit together

Each of the three works alone, with neither of the others installed. When they are in the same repo, they work together without overlapping.

| Tool | Answers | Owns | How it acts |
|---|---|---|---|
| [gantry](https://github.com/guangshinhaha/gantry) | Did it pass? | Local hooks, CI checks, the secret scan and the required `gantry / ci-ok` check | Runs checks with no judgment, and can block a merge |
| [shinstack](https://github.com/guangshinhaha/shinstack) | How should the agent work, and may it act? | Principles, playbooks, review depth, PR format and approval modes | Advises the agent |
| [shinfactory](https://github.com/guangshinhaha/shinfactory) | What runs next, and who runs it? | Stage order, retries, provider and model, and merges inside a factory order | Runs the loop |

To place a new rule, ask these in order and stop at the first yes:

1. Can a machine check it with no judgment? It goes in gantry. A check that only one repo needs goes in that repo's own workflow.
2. Does it need a schedule, a stage or an event? It goes in shinfactory.
3. Would it still apply to one person running one agent session with no loop? It goes in shinstack.

A merge needs both a green check and an approval. Gantry decides whether the checks pass. shinstack's `approval-modes` or shinfactory's `mode` decides whether the merge may happen.

Full reasoning: [the decision record](https://github.com/guangshinhaha/shinstack/blob/main/docs/decisions/shinstack-vs-shinfactory.md).

## What runs when

**On every commit** (fast, staged files only)
- **Secret scan** (gitleaks): blocks API keys, tokens and passwords.
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
- **Docs-only changes** (`docs/**`, `*.md`) always run the secret scan, because
  a key can be pasted into a doc. They skip the other checks above inside the
  job, so the status still reports instead of sitting on "pending".
- **`gantry / ci-ok`**: one summary check. It fails if any job failed or was
  cancelled; skipped jobs count as passing. This is the check to require.
- Optional: **second review by Claude** (see below). Runs once when a PR opens
  or leaves draft, then only on request.
- Optional (`--docker`): **Docker build**. PRs and `main` build the
  `Dockerfile` with the GHA cache to catch breakage. It never pushes: GovPaaS
  (Northflank), Railway and Vercel build the image themselves, and only AWS
  apps push to ECR. A registry push may come back later as an opt-in. Without
  a Dockerfile it skips and says so (`Skipped: no Dockerfile`) in the job
  summary.

**Optional extras** for some stacks
- `prisma`: blocks raw-SQL escape hatches (`$queryRawUnsafe`, `Prisma.raw()`);
  checks the Dockerfile copies the Prisma schema.
- `nextjs`: blocks database or API calls at build time; runs Playwright on push
  when app code changed.

Every check skips itself when a repo doesn't have the relevant script or
config, so it is safe to turn everything on everywhere.

## Repos that aren't plain Node

`ci.yml` has a `node` job for lint, format check, typecheck, tests and audit.
`gantry / ci-ok` stays green when the job skips, and the run's summary says why
(`Node checks skipped: <reason>`). The secret scan still runs and still counts.

- **No `package.json`** (a repo in any other language): the job skips with no
  setting needed.
- **A `package.json` in a repo with its own test workflow:** set `node: false`.
  Use it when gantry's job can't run the repo's checks, such as shinfactory,
  whose `test` script is `go test ./...` and needs the UI built first.

```yaml
jobs:
  gantry:
    uses: guangshinhaha/gantry/.github/workflows/ci.yml@main
    with:
      node: false
```

`gantry / ci-ok` doesn't cover the repo's own workflow, so a repo that sets
`node: false` isn't protected by its tests until
[#25](https://github.com/guangshinhaha/gantry/issues/25) is done.

## Blocking merges on red CI

CI alone doesn't stop a merge. To make `gantry / ci-ok` required on a repo's
default branch (repo admins can bypass), run once per repo:

```sh
~/Desktop/projects/gantry/bin/gantry-protect owner/repo [--dry-run]
```

It creates a ruleset named `gantry`, or updates it if it exists.
`--dry-run` prints the JSON payload and changes nothing. It needs `gh` signed
in as a repo admin.

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
under Stryker), monorepos and repos without tests. It reports only and never
blocks a merge, unless you set `thresholds.break` in `stryker.config.mjs`.
Two cases stay green and are explained in the comment: changed files that no
test covers (it names them), and existing tests that already fail (mutation
testing is skipped; the test job reports the failures). Only a real miss of
`thresholds.break` turns the check red.

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
~/Desktop/projects/gantry/bin/gantry-init [dir] [--prisma] [--nextjs] [--no-mutation] [--review] [--docker] [--ac-check]
git add -A && git commit -m "Add gantry checks"
```

`gantry-init` never overwrites a file that already exists, and is safe to run
again. It adds:

| File | What it is |
|---|---|
| `lefthook.yml` | Local hooks. Points at this repo, so updates arrive automatically (re-fetched daily). |
| `.github/workflows/ci.yml` | A few lines that call gantry's shared CI. |
| `.github/workflows/mutation.yml` | A few lines that call gantry's mutation testing. |
| `.github/workflows/preview.yml` | A few lines that call gantry's preview smoke tests. |
| `.github/workflows/risky-paths.yml` | A few lines that call gantry's `needs-human` labelling. |
| `.github/gantry-risky-paths` | Example list of risky globs. Edit to fit the repo. |
| `.github/workflows/review.yml` | Second review by Claude. Only with `--review`. |
| `.github/workflows/ac-check.yml` | Only with `--ac-check`: calls gantry's acceptance-criteria check. Kept if it already exists. |
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
                secrets only; no package.json or `node: false` skips node),
                secrets, node, then ci-ok (the one required check)
  mutation.yml  shared mutation testing that repos call
  preview.yml   shared preview smoke tests. Platform-neutral; the only
                platform-specific part is one "Find preview URL" step per platform.
                Optional Lighthouse step runs after smoke.
  risky-paths.yml  shared needs-human labelling that repos call
  review.yml    shared second review (claude-code-action) that repos call
  ac-check.yml  shared acceptance-criteria check (opt-in via --ac-check)
  build.yml     shared Docker build-and-verify, no push (opt-in via --docker)
template/       files gantry-init copies into a repo
bin/gantry-init sets a repo up
bin/gantry-protect requires gantry / ci-ok on the default branch (ruleset)
scripts/        mutation-report.mjs: turns Stryker's results into the PR comment
                preview-railway.mjs: Railway adapter, finds and checks the preview URL
                preview-vercel.mjs: Vercel adapter, reads the GitHub deployment status
                lighthouse-report.mjs: turns Lighthouse results into the PR comment section
                risky-paths.mjs: glob matching for needs-human (tests in scripts/test/)
                ac-check.mjs: parses PR/issue checklists (tests: ac-check.test.mjs)
```

Repos follow `main`, so a change here reaches every repo at once: the hooks on
their next daily re-fetch, CI on their next run. Test changes on one repo first.

To run CI on your own machine instead of GitHub's, pass
`runs-on: '["self-hosted","gantry"]'` in a repo's `ci.yml`.

## Next

See the [open issues](https://github.com/guangshinhaha/gantry/issues). Ideas not yet scoped
have the `idea` label; work waiting on something outside the repo has `blocked`.
