# <project name>

<One paragraph: what this is, who uses it, where it runs.>

## Commands

- `npm test` — unit tests
- `npm run lint` / `npx tsc --noEmit`
- `npm run dev` — local dev server

## Gates

Hooks and CI come from gantry (`lefthook.yml`, `.github/workflows/ci.yml`).
A task is done only when the pre-push checks pass. Never use `--no-verify`.

Mutation testing (`mutation.yml`) comments surviving mutants on PRs. To kill
them: add or tighten tests until each mutant fails a test; don't change app
code for it. Equivalent mutants get `// Stryker disable next-line <Mutator>: <reason>`.
Check locally with `npx stryker run --mutate <file>`.

## Working style

This repo uses the shinstack plugin (github.com/guangshinhaha/shinstack). On a non-trivial code task, load the `shinstack` skill first: restate the goal and the smallest change, verify against the real thing, work in small verifiable steps. Install: `claude plugin marketplace add guangshinhaha/shinstack`, then `claude plugin install shinstack@shinstack`.

## Review rules

- Auth, permissions, personal data and deploy scripts: a human reviews line by line.
- UI: review by screenshot.

## Knowledge

- Architecture: docs/architecture/
- Decisions: docs/decisions/
- Solved problems and gotchas: docs/solutions/
