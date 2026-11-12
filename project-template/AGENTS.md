# Agent guide

## Verification checks

Run these in order before you report a change as complete:

1. `npm run check`

<!-- CHANGEME: list the checks that npm run check chains (format, lint, types, boundaries, tests). -->

The pre-commit hook (`.githooks/pre-commit`, turned on by `npm install`) refuses any staged file over 5,000 tokens, then runs `npm run check`. CI runs the same checks on every PR. A change that touches a large file splits it in the same change.

## Where things are

- Domain terms: `GLOSSARY.md`. Name domain concepts with its terms: types, exported names, UI text, test names and PR prose. Local variables follow the surrounding code. A change that introduces a new domain concept adds its term to `GLOSSARY.md` in the same PR.
- Decisions the code cannot explain: `docs/adr/`.
- Review rules that no check enforces: `CODING_STANDARDS.md`.
- Docs change with the code. A PR that adds a domain term, a review rule or a hard-to-reverse decision updates `GLOSSARY.md`, `CODING_STANDARDS.md` or `docs/adr/` in the same PR.
- Task-specific guides: `docs/agents/`. Read the matching guide before you start that task.
- Issue tracker: GitHub issues, through `gh`. Specs, tickets, blocking edges and Wayfinder maps follow `docs/agents/issue-tracker.md`.

## When something breaks

| Symptom | Cause |
| --- | --- |
| <!-- CHANGEME --> | |

## Software factory

Issues labelled `agent:explore` start an explore run, which tags each issue and hands easy calls to `agent:implement`. Issues labelled `agent:implement` start an implementer run, which opens a draft PR. PRs labelled `agent:review` start a review run. A human merges. The `sf` CLI drives the whole flow from an idea: run `sf` in the repo root.
