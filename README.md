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

## What runs when

**On every commit** (fast, staged files only)
- **Secret scan** (gitleaks): blocks API keys, tokens and passwords.
- **No escape hatches:** blocks newly added `any`, `as any`, `@ts-ignore` and
  `eslint-disable`, the usual ways to make an error disappear instead of fixing it.
- **ESLint** on the staged files, if the repo uses ESLint.

**On every push**
- **Typecheck** (`tsc --noEmit`), **unit tests**, and a **dependency audit**
  (high severity and above, production dependencies only).

**On every pull request** (GitHub Actions)
- The same checks again on a clean machine: secrets, lint, typecheck, tests, audit.
- **Mutation testing** on the files the PR changed (see below). Survivors are
  posted as a PR comment.
- Optional: Playwright end-to-end tests.
- **Preview smoke tests** (Railway): once the PR's preview is live on the PR's
  latest commit, Playwright `@smoke` tests run against it. Screenshots are
  uploaded and one PR comment (updated on every push) shows pass or fail. See
  below.

**Optional extras** for some stacks
- `prisma`: blocks raw-SQL escape hatches (`$queryRawUnsafe`, `Prisma.raw()`);
  checks the Dockerfile copies the Prisma schema.
- `nextjs`: blocks database or API calls at build time; runs Playwright on push
  when app code changed.

Every check skips itself when a repo doesn't have the relevant script or
config, so it is safe to turn everything on everywhere.

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
4. `gantry-init` adds `.github/workflows/preview.yml`; or copy it from `template/`.

Without the secret (including PRs from forks) or without `@smoke` tests, the
job skips itself. Inputs: `platform`, `smoke-command`, `timeout-minutes`,
`railway-project-id`, `railway-service`.

## Using it

**New repo:** in Claude Code, run `/new-repo <git link>`. It clones the repo,
applies gantry, writes a starting CLAUDE.md, and asks before pushing.

**Existing repo:**

```sh
~/Desktop/projects/gantry/bin/gantry-init [dir] [--prisma] [--nextjs] [--no-mutation]
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
| `stryker.config.mjs` | Stryker config, with the repo's test runner detected. |
| `CLAUDE.md` | A starting template: commands, gates, review rules. |

Repos that use husky are left alone, with instructions for switching.

**Repo-specific checks** go in that repo's own `lefthook.yml` or workflow.
When one turns out to be useful everywhere, move it here.

## How it's built

```
hooks/          lefthook configs: base (every repo), node, prisma, nextjs
.github/workflows/
  ci.yml        shared CI that repos call
  mutation.yml  shared mutation testing that repos call
  preview.yml   shared preview smoke tests. Platform-neutral; the only
                platform-specific part is one "Find preview URL" step
template/       files gantry-init copies into a repo
bin/gantry-init sets a repo up
scripts/        mutation-report.mjs: turns Stryker's results into the PR comment
                preview-railway.mjs: Railway adapter, finds and checks the preview URL
BACKLOG.md      ideas not built yet
```

Repos follow `main`, so a change here reaches every repo at once: the hooks on
their next daily re-fetch, CI on their next run. Test changes on one repo first.

To run CI on your own machine instead of GitHub's, pass
`runs-on: '["self-hosted","gantry"]'` in a repo's `ci.yml`.

## Next

See [BACKLOG.md](BACKLOG.md): blocking merges on red CI, Vercel and Northflank preview
adapters, Lighthouse scans, and automatic survivor-killing.
