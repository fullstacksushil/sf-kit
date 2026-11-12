# Issue tracker: GitHub

Issues, specs and tickets for this repo are GitHub issues on the `origin` remote. Use the `gh` CLI for every operation. Adapted from the course repo's `docs/agents/issue-tracker.md`.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body-file <file>`. Write multi-line bodies to a file first.
- **Read an issue:** `gh issue view <number> --comments`.
- **List issues:** `gh issue list --state open --json number,title,body,labels` with `--label` and `--state` filters.
- **Comment:** `gh issue comment <number> --body-file <file>`.
- **Labels:** `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close:** `gh issue close <number> --comment "..."`.

If `gh repo set-default --view` does not show the `origin` repo, pass `-R <owner/repo>` on every command.

## When a skill says "publish to the issue tracker"

Create a GitHub issue. A spec from `/to-spec` gets the labels `spec` and `ready-for-agent`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Tickets from `/to-tickets`

- Make each ticket a sub-issue of its spec: `gh api --method POST repos/<owner>/<repo>/issues/<spec>/sub_issues -F sub_issue_id=<ticket-db-id>`.
- Add native blocking edges: `gh api --method POST repos/<owner>/<repo>/issues/<ticket>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
- The db id is `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. It is not the `#number`.
- **Always keep the `## Blocked by` section in the body too**, with one `- #<n>` line per blocker, or `None`. The `sf` CLI reads the frontier from it.
- Label each ticket `ready-for-agent`. Do not add `agent:*` labels: `sf` hands the frontier to the factory.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- **Map:** an issue labelled `wayfinder:map`, holding the Destination, Notes, Decisions so far, Not yet specified and Out of scope sections.
- **Child ticket:** a sub-issue of the map (the sub-issues call above), labelled `wayfinder:<type>` (`research`, `prototype`, `grilling` or `task`).
- **Blocking:** native dependencies (the call above), plus the `## Blocked by` section in the body.
- **Frontier:** the map's open children with no open blocker and no assignee.
- **Claim:** `gh issue edit <n> --add-assignee @me`, as the session's first write.
- **Resolve:** comment the answer, close the ticket, then add a one-line gist and link to the map's Decisions so far.
