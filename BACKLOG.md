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

- **Northflank/GovPaaS preview adapter** for `preview.yml` (Railway and Vercel
  are done). Previews are publicly reachable but GovPaaS has no PR previews
  yet; see `docs/spikes/northflank-preview-reachability.md`. Shelved.

## Infra

- **Self-hosted runner** (`runner/` for Railway: pinned image, ephemeral,
  needs a personal GitHub org to serve all repos). Only when secrets/network
  require it or a CPU-bound suite needs more than 2 vCPUs (notifysg: ~18 min).
- **Auto-kill survivors** with claude-code-action on a `kill-mutants` label
  (costs API usage; do it by hand first).

## Notes

- OGP enforcement spectrum = gantry's layers: CLAUDE.md (easy to ignore) →
  local hooks → CI (can't be skipped). Lint runs in both hooks and CI.
- node:test on ubuntu-26.04 runners defaults to effectively serial; pass
  `--test-concurrency` explicitly (notifysg #383).
