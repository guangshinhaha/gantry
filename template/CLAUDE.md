# <project name>

<One paragraph: what this is, who uses it, where it runs.>

## Commands

- `npm test` — unit tests
- `npm run lint` / `npx tsc --noEmit`
- `npm run dev` — local dev server

## Gates

Hooks and CI come from gantry (`lefthook.yml`, `.github/workflows/ci.yml`).
A task is done only when the pre-push checks pass. Never use `--no-verify`.

## Review rules

- Auth, permissions, personal data and deploy scripts: a human reviews line by line.
- UI: review by screenshot.

## Knowledge

- Architecture: docs/architecture/
- Decisions: docs/decisions/
- Solved problems and gotchas: docs/solutions/
