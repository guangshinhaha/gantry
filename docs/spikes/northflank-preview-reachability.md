# Spike: can GitHub-hosted runners reach Northflank / GovPaaS previews? (issue #5)

Date: 2026-11-05. Method: Northflank public docs only. Nothing was run against a real
Northflank team or GovPaaS tenant, so nothing below is tested.

## Verdict

**Unclear. Not built.** Treat as blocked on the self-hosted runner (#12) until Shin
confirms how the actual GovPaaS preview is exposed.

## What the docs say

- Preview blueprints create one environment per PR, named by PR id, branch, timestamp or
  random words (configurable prefix/suffix). Deleted when the PR closes.
  https://northflank.com/docs/v1/application/release/set-up-preview-blueprints
- Each preview gets its own URL. Only the public-facing service is exposed; other services
  stay on private networking. Exposure is a per-port setting: a port has `public` (bool),
  `vpcAccessible` (bool) and a default `code.run` DNS name, plus optional custom domains.
  https://northflank.com/docs/v1/api/services/get-service-ports (endpoint is deprecated in
  favour of get-service)
- So on Northflank's own cloud, a public port on the default `code.run` domain is reachable
  from the internet, hence from GitHub-hosted runners.

## Why it is still unclear for GovPaaS

- I found no public source linking "GovPaaS" to Northflank, or saying how it is networked.
  A GovTech job post mentions Northflank only as a stack component.
- If GovPaaS runs Northflank BYOC in a government VPC/GCC with `vpcAccessible`-only ports,
  an IP allowlist or SSO in front, hosted runners cannot reach it. That is plausible for
  government workloads but unverified.
- Whether the preview port is `public` is per blueprint, so it can differ per repo.

## URL discovery (also unverified)

The preview-blueprint docs do not say how to get a preview's URL. Likely route (from
memory of the API shape, not checked): `NORTHFLANK_TOKEN` bearer auth, list the project's
services, find the one whose name carries the PR suffix (e.g. `*-pr-123`), read its ports
and take the port with `public: true` and its `dns`. Needs a real response to confirm field
names and how to match the deployed commit SHA (Railway's adapter checks the SHA; the
Northflank equivalent is likely the build/deployment `sha` on the service, unconfirmed).

## To close this out (needs Shin, by hand)

1. In a real GovPaaS preview, open the preview URL from a network outside the government
   VPN (phone hotspot). Reachable = adapter can be built like `scripts/preview-railway.mjs`.
2. If not reachable, build the adapter to run on the self-hosted runner (#12).
3. Either way, confirm one real `GET .../services/{id}` response to pin field names.

## Update 2026-11-05: checked with the Northflank CLI (read-only)

- **Reachable.** A service in `sums-dev` exposes a public port on the default
  `*.code.run` domain with no IP policy, credentials or SSO. `curl -I` from a
  laptop with no VPN returned HTTP 200, so GitHub-hosted runners should reach
  it too. A self-hosted runner (#12) is not needed for this.
- **No previews exist yet.** Org `moe-dxd-tfx` has 7 projects, one fixed
  environment each (built from `northflank/template.json`-style templates) and
  no pipelines in the five I checked, so there is nothing for an adapter to find.
- **Route if wanted later:** per-branch auto-deploy on a service gives each PR
  branch its own URL. Not checked: whether our GovPaaS plan allows it.
  Then add a `northflank` URL-discovery step to `preview.yml` that maps the PR
  branch to its service URL.
- **Decision:** shelved. Low priority; not building the adapter now.
