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

Every Node check skips itself when the repo lacks the script or config.

## Use it

New or existing repo:

```sh
~/Desktop/projects/gantry/bin/gantry-init [dir] [--prisma] [--nextjs]
git add lefthook.yml .github/workflows/ci.yml && git commit -m "Add gantry checks"
```

It never overwrites files. Repos on husky are left alone with instructions
for switching.

Repo-specific checks go in that repo's own `lefthook.yml` under `remotes`.
A check that turns out useful everywhere moves here.

## Self-hosted runner (later)

Pass `runs-on: '["self-hosted","gantry"]'` in a repo's `ci.yml`. Keep the
runner ephemeral, private repos only, and keep secrets on the runner host.
