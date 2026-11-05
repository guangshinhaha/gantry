# Backlog

Ideas waiting for Shin's go. Not implemented.

## Merge confidence

- **Block merging on red CI.** A `ci-ok` aggregate job (passes when every
  job succeeded or was skipped) plus a ruleset on main requiring it, with an
  owner bypass. Replace workflow-level `paths-ignore` with in-job skips so a
  required check never sits on "pending". Pair with Railway's "Wait for CI".
- **Per-PR preview + smoke tests** (`preview.yml`). One shared job (wait
  for URL, Playwright smoke, screenshots posted to the PR, check the deployed
  commit) with platform adapters: Railway (API with `RAILWAY_TOKEN`; GitHub
  deployment URLs point at the dashboard), Northflank/GovPaaS (CLI/API; may
  need a self-hosted runner if previews are internal-only), Vercel (GitHub
  deployment URL). Pilot: notifysg's next PR (PR environments enabled).
- **Lighthouse scan in CI** for accessibility and performance against the
  preview URL (OGP caught a 5MB icon this way). Depends on preview.yml.
- **`needs-human` label** for PRs touching risky paths (auth, tenancy/RLS,
  payments, API keys, migrations), listed per repo.
- **Acceptance criteria check**: PR template lists the issue's ACs; CI fails
  on unticked ones.

## Infra

- **Self-hosted runner** (`runner/` for Railway: pinned image, ephemeral,
  needs a personal GitHub org to serve all repos). Only when secrets/network
  require it or a CPU-bound suite needs more than 2 vCPUs (notifysg: ~18 min).
- **`build.yml`**: Docker build to GHCR, for apps not built by their platform.

- **Auto-kill survivors** with claude-code-action on a `kill-mutants` label
  (costs API usage; do it by hand first).

## Notes

- OGP enforcement spectrum = gantry's layers: CLAUDE.md (easy to ignore) →
  local hooks → CI (can't be skipped). Lint runs in both hooks and CI.
- node:test on ubuntu-26.04 runners defaults to effectively serial; pass
  `--test-concurrency` explicitly (notifysg #383).
