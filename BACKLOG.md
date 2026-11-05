# Backlog

Ideas waiting for Shin's go. Not implemented.

## Init

- **`gantry-init` writes files the target repo's formatter rejects.** Found on
  tw-marketplace-manual (2026-11-05): `CLAUDE.md` and `preview.yml` failed
  `oxfmt --check .`, so `format:check` went red on `main` and every PR's
  frontend job failed until a follow-up fix (#149). Idea: after copying, run
  the repo's formatter on the added files if one is configured (or print a
  "run your formatter before committing" line), and have `/new-repo` run the
  repo's checks before it offers to push. Related: `preview.yml` defaults to
  `platform: railway` even on repos that deploy elsewhere (Northflank here).

## Merge confidence

- **GovPaaS per-PR previews**: tracked in issue #5 (blocked on a permission).
- **Complexity check** in CI and hooks (ESLint `complexity` or similar). Pure
  gate, no secrets. From the OGP session (Nov 3).
- **Visual before/after diffs** on the preview screenshots (OGP uses Chromatic),
  so UI review is a glance. Needs a baseline store. Check PDPA before sending
  screenshots to a third party.
- **Multiple LLM reviewers + a comment resolver.** Extends the opt-in Claude
  review: several reviewers comment, then a skill synthesises and resolves
  (`ce-resolve-pr-feedback` already covers the resolving half).

## Infra

- **Self-hosted runner** (`runner/` for Railway: pinned image, ephemeral,
  needs a personal GitHub org to serve all repos). Only when secrets/network
  require it or a CPU-bound suite needs more than 2 vCPUs (notifysg: ~18 min).
- **Auto-kill survivors** with claude-code-action on a `kill-mutants` label
  (costs API usage; do it by hand first).
- **Observability as code** (OGP): monitors, dashboards and SLOs live in the
  repo and update when the schema or log lines change; alerts to Slack. Bigger
  than a CI check; decide Datadog vs Grafana first.

## Notes

- OGP enforcement spectrum = gantry's layers: CLAUDE.md (easy to ignore) →
  local hooks → CI (can't be skipped). Lint runs in both hooks and CI.
- node:test on ubuntu-26.04 runners defaults to effectively serial; pass
  `--test-concurrency` explicitly (notifysg #383).
