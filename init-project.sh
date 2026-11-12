#!/usr/bin/env bash
# Make a project factory ready: agent guide files, the course's skills and agent scripts,
# and (for an existing project) a "state of the repo" report. Never overwrites a file. It adds one
# package.json script (prepare, to turn on the pre-commit hook) when the project has none.
# Then follow ../playbooks/01-greenfield.md (new) or ../playbooks/02-brownfield.md (existing).
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
TARGET="$PWD" MODE="" DRY=0 LABELS=0
COURSE="$KIT/../cohort-005-project" COURSE_REF=origin/live-run-through
# Course skills that only make sense inside the course repo.
SKIP_SKILLS="ask-matt knock-workflows teach setup-matt-pocock-skills"

usage() {
  cat <<EOF
Usage: $0 [--path DIR] [--new|--existing] [--course-repo DIR] [--labels] [--dry-run]

  --path DIR         Project to set up (default: current directory).
  --new|--existing   Force the mode. Default: existing if the repo has commits.
  --course-repo DIR  Clone of ai-hero-dev/cohort-005-project (default: $COURSE).
                     Skills and .sandcastle/agent-workflows come from its $COURSE_REF branch.
  --labels           Create the factory labels on the GitHub repo with gh.
  --dry-run          Print what would change. Change nothing.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --path) TARGET="$2"; shift 2 ;;
    --new) MODE=new; shift ;;
    --existing) MODE=existing; shift ;;
    --course-repo) COURSE="$2"; shift 2 ;;
    --labels) LABELS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
cd "$TARGET"
if [ -z "$MODE" ]; then
  if git rev-parse --verify HEAD >/dev/null 2>&1; then MODE=existing; else MODE=new; fi
fi
say() { printf '\n== %s\n' "$*"; }
CREATED=() KEPT=()

# Copy one file into the project unless it exists.
place() {
  local src="$1" dest="$2"
  if [ -e "$dest" ]; then KEPT+=("$dest"); return; fi
  CREATED+=("$dest")
  [ "$DRY" = 1 ] && return
  mkdir -p "$(dirname "$dest")"; cp "$src" "$dest"
}
# Copy a tree, file by file, without overwriting.
place_tree() {
  local src="$1" dest="$2" f
  while IFS= read -r -d '' f; do place "$f" "$dest/${f#"$src"/}"; done < <(find "$src" -type f -print0)
}

say "Project: $TARGET ($MODE)"
if [ "$MODE" = new ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
  [ "$DRY" = 1 ] && echo "+ git init" || git init -q
fi

say "Agent guide files"
place_tree "$KIT/project-template" "$TARGET"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "@AGENTS.md" > "$tmp/CLAUDE.md"
place "$tmp/CLAUDE.md" "$TARGET/CLAUDE.md"
for d in docs/adr docs/agents; do
  [ -d "$d" ] || { CREATED+=("$TARGET/$d/"); [ "$DRY" = 1 ] || mkdir -p "$d"; }
done
# sf keeps its local state (session ids, the current spec) in .sf/. It is per machine, so git ignores it.
if ! grep -qxF '.sf/' .gitignore 2>/dev/null; then
  CREATED+=("$TARGET/.gitignore (.sf/)"); [ "$DRY" = 1 ] || echo '.sf/' >> .gitignore
fi

say "Skills and agent scripts from the course repo"
if git -C "$COURSE" rev-parse --verify "$COURSE_REF" >/dev/null 2>&1; then
  git -C "$COURSE" archive "$COURSE_REF" .agents/skills .sandcastle/agent-workflows .sandcastle/Dockerfile | tar -x -C "$tmp"
  for s in $SKIP_SKILLS; do rm -rf "$tmp/.agents/skills/$s"; done
  # Explore's third verdict (lesson 08-08): "prototype-needed" hands the ticket to sf-kit's prototype task.
  sed -i 's/\.enum(\["easy-call", "needs-a-human", "blocked"\])/.enum(["easy-call", "needs-a-human", "blocked", "prototype-needed"])/' \
    "$tmp/.sandcastle/agent-workflows/explore/plan-schema.ts"
  sed -i '/^   - `blocked`: waiting on something outside this repository/a\
   - `prototype-needed`: the open question is how it should look or behave, and people should react to a rough prototype before anyone decides. The factory builds one and posts screenshots.' \
    "$tmp/.sandcastle/agent-workflows/explore/prompt.md"
  # The course's hook lives in .husky/ and scripts/pre-commit.sh. sf-kit's is .githooks/pre-commit, with
  # scripts/check-file-tokens.mjs (both from project-template/).
  wf="$tmp/.sandcastle/agent-workflows"
  sed -i 's#`.husky/`, `scripts/pre-commit.sh`#`.githooks/`, `scripts/check-file-tokens.mjs`#' "$wf/implement/prompt.md" "$wf/implement-spec/build-prompt.md"
  sed -i 's#scripts/check-file-tokens\.js#scripts/check-file-tokens.mjs#' "$wf/review/prompt.md"
  # The docs loop: the factory updates the glossary, the standards and the ADRs in the PRs it builds and reviews.
  for f in "$wf/implement/prompt.md" "$wf/implement-spec/build-prompt.md"; do cat >> "$f" <<'DOCS'

## Docs change with the code

- /tmp/ticket.md ends with the parent spec when the ticket has one. Its
  implementation decisions bind you as much as the ticket does.
- GLOSSARY.md names domain concepts: types, exported names, UI text and test
  names. Local variables follow the surrounding code. A new domain concept
  gets its term in GLOSSARY.md in the same commit.
- A decision that the code cannot explain and that is hard to reverse gets an
  ADR in docs/adr/.
DOCS
  done
  cat >> "$wf/review/prompt.md" <<'DOCS'

## Docs change with the code

/tmp/review-spec.md ends with the parent spec when the ticket has one. On the
Spec axis, check the change against the spec's implementation decisions too.

GLOSSARY.md names domain concepts: types, exported names, UI text and test
names. Do not rename local variables or test helpers for the glossary. When
the PR uses a domain concept that GLOSSARY.md lacks, add the term in a fix
commit.

For each rule you wanted and could not find:

- A judgement call that no lint or test can check: add it to
  CODING_STANDARDS.md in its own commit, in the format the file describes.
  Then fix the change to follow it. The person who merges approves the rule.
- A rule that a check could enforce: do not add it. Name the check to add.

List both kinds under "Rules this review wanted and could not find", and say
which ones you added to CODING_STANDARDS.md.
DOCS
  rm -f "$tmp/.agents/skills/.gitkeep"
  place_tree "$tmp/.agents" "$TARGET/.agents"
  place_tree "$tmp/.sandcastle" "$TARGET/.sandcastle"
  # Claude Code reads skills from .claude/skills. The course repo links it to .agents/skills.
  if [ ! -e .claude/skills ]; then
    CREATED+=("$TARGET/.claude/skills -> ../.agents/skills")
    [ "$DRY" = 1 ] || { mkdir -p .claude && ln -s ../.agents/skills .claude/skills; }
  fi
else
  echo "Skipped: no $COURSE_REF in $COURSE. Run: git -C <course-repo> fetch origin live-run-through"
fi

# Turn on .githooks/pre-commit at npm install, in this clone and in every agent clone (their setup runs npm ci).
# Only with a check script for the hook to run, and only when the project has no hook setup of its own.
if [ -f package.json ] && [ ! -d .husky ]; then
  say "Pre-commit hook"
  hook=$(node -e 'const s=require("./package.json").scripts||{};console.log(s.prepare?"has-prepare":s.check?"ok":"no-check")')
  case "$hook" in
    ok) CREATED+=("$TARGET/package.json (scripts.prepare: git config core.hooksPath .githooks)")
        [ "$DRY" = 1 ] || { node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.scripts.prepare="git config core.hooksPath .githooks || true";fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
          git config core.hooksPath .githooks; }
        echo "hook on: .githooks/pre-commit" ;;
    has-prepare) echo "package.json has a prepare script. Add to it: git config core.hooksPath .githooks" ;;
    *) echo "No check script in package.json, so the hook stays off. Add one, then set prepare to: git config core.hooksPath .githooks" ;;
  esac
fi

if [ "$MODE" = existing ]; then
  say "State of the repo report (brownfield Phase 0)"
  report="$TARGET/docs/agents/state-of-the-repo.md"
  if [ -e "$report" ]; then KEPT+=("$report")
  else
    CREATED+=("$report")
    {
      echo "# State of the repo"
      echo
      echo "Generated by sf-kit/init-project.sh on $(date +%F). Delete this file when brownfield Phase 3 is done."
      echo
      echo "## Most changed files, last 6 months"
      echo
      echo '```text'
      git log --since=6.months --format= --name-only 2>/dev/null | grep -v '^$' | sort | uniq -c | sort -rn | head -15 || true
      echo '```'
      echo
      echo "## Files over 5,000 tokens (bytes / 4)"
      echo
      echo '```text'
      git ls-files -z | xargs -0 -r stat -c '%s %n' 2>/dev/null | awk '$1/4 > 5000 && $2 !~ /(lock|\.svg|\.png|\.jpg|\.db)/ {printf "%7d tokens  %s\n", $1/4, $2}' | sort -rn | head -20 || true
      echo '```'
      echo
      echo "## Signals"
      echo
      echo "- Tracked files: $(git ls-files | wc -l)"
      echo "- Test files: $(git ls-files | grep -cE '(\.test\.|\.spec\.|_test\.|/tests?/)' || true)"
      echo "- CI workflows: $(git ls-files '.github/workflows/*' | wc -l)"
      echo "- Pre-commit hook: $( [ -e .husky/pre-commit ] || [ -e .pre-commit-config.yaml ] && echo yes || echo no)"
      if [ -f package.json ]; then
        echo "- npm scripts present: $(node -e 'const s=require("./package.json").scripts||{};console.log(["check","lint","typecheck","test","format"].filter(k=>s[k]).join(", ")||"none of check/lint/typecheck/test/format")')"
      fi
      echo
      echo "## To answer by hand"
      echo
      echo "1. Does the project run from scratch in a container?"
      echo "2. How long does the full check take? Time each part."
      echo "3. Which terms do users, the UI and the code use differently?"
    } > "$tmp/state.md"
    [ "$DRY" = 1 ] || cp "$tmp/state.md" "$report"
  fi
fi

if [ "$LABELS" = 1 ]; then
  say "GitHub labels"
  while IFS='|' read -r name color desc; do
    if [ "$DRY" = 1 ]; then echo "+ gh label create $name"
    else gh label create "$name" --color "$color" --description "$desc" --force >/dev/null && echo "label: $name"; fi
  done <<'EOF'
agent:explore|5319E7|The factory explores this ticket and tags it
agent:prototype|5319E7|Build or update a throwaway prototype for this issue
agent:implement-spec|5319E7|Night shift: build every ticket of this spec into one integration PR
agent:rebase|5319E7|Rebase this PR onto its base now
prototype|BFD4F2|Has a prototype. Comment @factory with feedback for the next version
do-not-merge|B60205|A prototype or experiment. Never merge it
architecture|C2E0C6|A deepening candidate from the architecture review
agent:implement|5319E7|Hand this issue to the implementer agent
agent:review|5319E7|Ask the review agent to read this pull request
agent:in-progress|FBCA04|An agent is working on this right now
agent:blocked|B60205|An agent run failed here. Its comment says how to retry
needs-a-human|D93F0B|The factory stopped here
ready-for-agent|0E8A16|Specified well enough for an agent to pick up
spec|1D76DB|A spec from /to-spec. Its sub-issues are the tickets
wayfinder:map|C5DEF5|A Wayfinder map of decision tickets
wayfinder:research|C5DEF5|Wayfinder ticket: research, worked by an agent alone
wayfinder:prototype|C5DEF5|Wayfinder ticket: a prototype to react to
wayfinder:grilling|C5DEF5|Wayfinder ticket: a grilling session
wayfinder:task|C5DEF5|Wayfinder ticket: manual work that unblocks a decision
ratchet|0E8A16|One lint failure fixed by the daily ratchet
EOF
fi

say "Result"
show() { local i=0 f; for f in "$@"; do i=$((i+1)); [ $i -le 12 ] && echo "  ${f#"$TARGET"/}"; done; [ $i -gt 12 ] && echo "  ... and $((i-12)) more"; return 0; }
echo "created: ${#CREATED[@]}"; show "${CREATED[@]}"
echo "kept (already existed): ${#KEPT[@]}"; show "${KEPT[@]}"
[ "$DRY" = 1 ] && echo "(dry run: nothing written)"

say "Next steps"
cat <<EOF
1. Install the agent runner deps: npm i -D @ai-hero/sandcastle@^0.14 tsx zod@^3.25
2. Edit the CHANGEME parts of AGENTS.md and GLOSSARY.md.
3. Read .sandcastle/agent-workflows/*/prompt.md. They name the course's checks. Point them at yours.
4. Follow ../playbooks/$( [ "$MODE" = new ] && echo 01-greenfield.md || echo 02-brownfield.md ) from Phase $( [ "$MODE" = new ] && echo 0 || echo "0 (start with docs/agents/state-of-the-repo.md)" ).
5. When the project runs in a container, connect it to a host set up with sf-kit/init-host.sh:
   set GITHUB_REPO in /etc/factory/orchestrator.env and add the GitHub webhook.
EOF
