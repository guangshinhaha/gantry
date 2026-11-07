# <project name>

<One paragraph: what this is, who uses it, where it runs.>

## Commands

- `npm run dev` — local dev server

## Gates

Hooks and CI come from gantry (`lefthook.yml`, `.github/workflows/ci.yml`).
A task is done only when the pre-push checks pass. Never use `--no-verify`.

Mutation testing (`mutation.yml`) comments surviving mutants on PRs. To kill
them: add or tighten tests until each mutant fails a test; don't change app
code for it. Equivalent mutants get `// Stryker disable next-line <Mutator>: <reason>`.
Check locally with `npx stryker run --mutate <file>`.

CI runs every check even when an earlier one fails, so read the whole run, not
just the first red step. With `node:test`, tests that share state (DB, ports,
files) collide under the default parallelism: pass `--test-concurrency=1`.

## Working style

If the shinstack plugin (github.com/guangshinhaha/shinstack) is installed, follow `shinstack:craft`, which its session hook loads. If it isn't installed, ignore this section.

## Review rules

- Auth, permissions, personal data and deploy scripts: a human reviews line by line.
- UI: review by screenshot.

## Knowledge

- Architecture: docs/architecture/
- Decisions: docs/decisions/
- Solved problems and gotchas: docs/solutions/
