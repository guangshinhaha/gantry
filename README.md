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
- **`needs-human` label** when the PR touches a risky path (auth, migrations,
  payments, API keys, RLS). See below.
- Optional: Playwright end-to-end tests.

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
| `.github/workflows/risky-paths.yml` | A few lines that call gantry's `needs-human` labelling. |
| `.github/gantry-risky-paths` | Example list of risky globs. Edit to fit the repo. |
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
  risky-paths.yml  shared needs-human labelling that repos call
template/       files gantry-init copies into a repo
bin/gantry-init sets a repo up
scripts/        mutation-report.mjs: turns Stryker's results into the PR comment
                risky-paths.mjs: glob matching for needs-human (tests in scripts/test/)
BACKLOG.md      ideas not built yet
```

Repos follow `main`, so a change here reaches every repo at once: the hooks on
their next daily re-fetch, CI on their next run. Test changes on one repo first.

To run CI on your own machine instead of GitHub's, pass
`runs-on: '["self-hosted","gantry"]'` in a repo's `ci.yml`.

## Next

See [BACKLOG.md](BACKLOG.md): blocking merges on red CI, a preview deploy for
every PR with smoke tests, Lighthouse scans, and automatic survivor-killing.
