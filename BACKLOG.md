# Backlog

Ideas waiting for Shin's go. Not implemented.

## Merge confidence

- **Northflank/GovPaaS preview adapter** for `preview.yml` (Railway and Vercel
  are done). Previews are publicly reachable but GovPaaS has no PR previews
  yet; see `docs/spikes/northflank-preview-reachability.md`. Shelved.
- **Automated second review** on every PR (dx-code-review or codex).
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
