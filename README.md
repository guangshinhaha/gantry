# gantry

The frame the robots build in. Deterministic checks around LLM-written code,
shared across all my repos.

Three layers, from easy for Claude to ignore to impossible to skip:

1. `CLAUDE.md`: guidance (template in `template/`)
2. **Local hooks** (lefthook): run on commit and push
3. **CI** (reusable GitHub workflow): runs on the server; `--no-verify` doesn't help

## Checks

| Config | Hook | Checks |
|---|---|---|
| `hooks/base.yml` | pre-commit | gitleaks secret scan; no `any` / `@ts-ignore` / `eslint-disable` |
| `hooks/node.yml` | pre-commit | eslint on staged files |
| | pre-push | `tsc --noEmit`, `test`, audit (high+, prod deps) |
| `hooks/prisma.yml` | pre-commit | no `$queryRawUnsafe` / `Prisma.raw()`; Dockerfile copies prisma |
| `hooks/nextjs.yml` | pre-commit | no DB/API calls at build time |
| | pre-push | Playwright e2e when app code changed |
| `.github/workflows/ci.yml` | CI | gitleaks, lint, typecheck, test, audit, optional e2e |
| `.github/workflows/mutation.yml` | CI (PRs) | Stryker on the files the PR changed; survivors posted as a PR comment |

Every Node check skips itself when the repo lacks the script or config.

## Use it

New or existing repo:

```sh
~/Desktop/projects/gantry/bin/gantry-init [dir] [--prisma] [--nextjs] [--no-mutation]
git add -A && git commit -m "Add gantry checks"
```

It never overwrites files. Repos on husky are left alone with instructions
for switching.

Repo-specific checks go in that repo's own `lefthook.yml` under `remotes`.
A check that turns out useful everywhere moves here.

## Mutation testing

Mutation testing checks that tests catch bugs: Stryker makes small changes to
the code (`>` → `>=`, `&&` → `||`, drops a call) and reruns the tests. A change
no test notices is a *survivor*: behaviour nothing checks.

- **On by default** for single-package Vitest/Jest repos: `gantry-init` adds
  `stryker.config.mjs`, the Stryker dev deps and `mutation.yml`. Off for
  node:test (too slow under Stryker), monorepos and repos without tests.
- **Runs on non-draft PRs**, mutating only changed source files. Incremental
  results are cached, stale runs cancelled, and Stryker stops at 15 min
  (`max-minutes`). Manual full run: workflow_dispatch.
- **Report-only.** Set `thresholds.break` in the config to fail the check.
- **The loop:** ask Claude to "kill the survivors on PR #N". It adds tests,
  never changes app code to kill a mutant, and marks equivalent mutants with
  `// Stryker disable next-line <Mutator>: <reason>`.
- Locally: `npx stryker run --mutate src/lib/foo.ts`, then
  `node ~/Desktop/projects/gantry/scripts/mutation-report.mjs`.
- Codegen before the type checker: Prisma is generated automatically; pass
  `prepare:` for anything else.

Measured on sums (PR #287's 4 files, 84 mutants): 85 s locally, 88% score;
caught an untested "this month" check in the quota count.

## Self-hosted runner (later)

Pass `runs-on: '["self-hosted","gantry"]'` in a repo's `ci.yml`. Keep the
runner ephemeral, private repos only, and keep secrets on the runner host.
