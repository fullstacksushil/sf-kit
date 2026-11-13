import { Octokit } from "@octokit/rest";
import { NonRetriableError } from "inngest";
import * as docker from "./docker.ts";

export const gh = new Octokit({ auth: process.env.FACTORY_PAT });
export const [owner, repo] = (process.env.GITHUB_REPO ?? "/").split("/");
export const remote = `https://github.com/${owner}/${repo}.git`;
export const ghToken = () => ({ GH_TOKEN: process.env.FACTORY_PAT! });

// Project setup inside the run container. Override per project in orchestrator.env.
const SETUP = process.env.RUN_SETUP ?? "npm ci && npm run --if-present db:migrate && npm run --if-present db:seed";
// Private GitHub repos the project's package.json installs from (for example "acme/shared"), space separated.
// The token step clones each one to /work/deps. Setup reads them from there, so setup still has no token.
export const PRIVATE_DEPS = (process.env.RUN_PRIVATE_DEPS ?? "").split(/\s+/).filter(Boolean).map((d) => {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(d) || d.includes("..")) throw new Error(`RUN_PRIVATE_DEPS: not owner/repo: ${JSON.stringify(d)}`);
  return d;
});
const MAX_MINUTES = Number(process.env.RUN_MAX_MINUTES ?? 45);
export const SLOTS = Number(process.env.FACTORY_SLOTS ?? 2);

/** The parts of Inngest's step tools that a run uses. */
export type Step = {
  run<T>(id: string, fn: () => Promise<T>): Promise<unknown>;
  sleep(id: string, duration: string): Promise<unknown>;
};

/** A git ref we put into shell scripts. GitHub allows `$`, `;` and `(` in branch names, so check every ref first. */
export function safeRef(ref: string): string {
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.startsWith("-") || ref.includes("..")) throw new NonRetriableError(`Refusing the ref name ${JSON.stringify(ref)}.`);
  return ref;
}
/** Issue and PR numbers come from events. Anyone with the event key can send an event, so check them. */
export function issueNumber(n: unknown): number {
  if (!Number.isInteger(n) || (n as number) <= 0) throw new NonRetriableError(`Not an issue number: ${JSON.stringify(n)}`);
  return n as number;
}

/**
 * Shell lines that clone with the token, then strip the token from the remote. The agent does not exist yet,
 * and no project code runs here: setup runs in its own step without the token (see runAgent).
 * `rm -rf repo` makes a retry of this step start clean.
 */
export const cloneScript = (checkout: string) => `
  rm -rf repo deps
  ${PRIVATE_DEPS.map((d) => `git clone -q --bare "https://x-access-token:$GH_TOKEN@github.com/${d}.git" deps/${d}.git
  git -C deps/${d}.git remote set-url origin https://github.com/${d}.git`).join("\n  ")}
  git clone -q "https://x-access-token:$GH_TOKEN@github.com/${owner}/${repo}.git" repo
  cd repo
  git remote set-url origin ${remote}
  git config user.name "agent-factory[bot]"
  git config user.email "agent-factory[bot]@users.noreply.github.com"
  ${checkout}
  git rev-parse HEAD > /tmp/base-sha
`;

/**
 * Defines the shell function sf_issue_ok N: success when agents may follow issue N. Agents follow what an issue
 * says, so on a public repo a stranger must not hand them orders. Only the author and people with triage access or
 * more can label an issue or change its title or body. So a stranger's issue counts once a collaborator labels it,
 * as long as the author changes neither title nor body after that first label. A later change by a collaborator
 * vouches for the text. Run it after the issue is read, so an edit in between is caught.
 * check: GET /repos/{owner}/{repo}/collaborators/{username}/permission and its role_name, with the PAT.
 * check: lastEditedAt and editor on the GraphQL Issue type.
 */
export const issueCheckFn = `
  sf_issue_ok() {
    local n="$1" who login events first="" at ev actor rat="" ractor="" eat eeditor
    who=$(gh api repos/${owner}/${repo}/issues/$n --jq '.author_association + " " + .user.login') || return 1
    case "\${who%% *}" in OWNER|MEMBER|COLLABORATOR) return 0 ;; esac
    login="\${who#* }"
    events=$(gh api --paginate repos/${owner}/${repo}/issues/$n/events \\
      --jq '.[] | select(.event == "labeled" or .event == "renamed") | "\\(.created_at) \\(.event) \\(.actor.login // "-")"') || return 1
    # Issue templates and workflows can add labels for anyone, so the label's actor must hold triage or more.
    while read -r at ev actor; do
      [ "$ev" = labeled ] || continue
      case "$(gh api "repos/${owner}/${repo}/collaborators/$actor/permission" --jq .role_name 2>/dev/null || true)" in
        admin|maintain|write|triage) first="$at"; break ;;
      esac
    done <<< "$events"
    [ -n "$first" ] || return 1
    while read -r at ev actor; do [ "$ev" = renamed ] && rat="$at" ractor="$actor"; done <<< "$events"
    [ "$ractor" = "$login" ] && [[ "$rat" > "$first" ]] && return 1
    read -r eat eeditor < <(gh api graphql -F n="$n" -f o=${owner} -f r=${repo} \\
      -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){lastEditedAt editor{login}}}}' \\
      --jq '.data.repository.issue | "\\(.lastEditedAt // "-") \\(.editor.login // "-")"') || return 1
    [ -n "\${eat:-}" ] || return 1
    ! { [ "$eeditor" = "$login" ] && [[ "$eat" > "$first" ]]; }
  }
`;

/** Shell lines that stop the step unless agents may follow issue `issue` (a number or a shell variable such as "$issue"). */
export const trustedIssueScript = (issue: string) => `${issueCheckFn}
  sf_issue_ok ${issue} || { echo "#${issue}: someone outside the repo wrote it, and no collaborator labelled it, or the author changed it after the label. A collaborator edits it to vouch for it, or files it again."; exit 1; }
`;

/**
 * The ticket goes to a file with only collaborator comments, the filter the course workflows use.
 * Titles, bodies and comments never pass through the shell.
 */
export const ticketScript = (n: number, file = "/tmp/ticket.md") => `
  gh issue view ${issueNumber(n)} --repo ${owner}/${repo} --json number,title,body,comments \\
    | jq '.comments |= map(select((.authorAssociation | IN("OWNER","MEMBER","COLLABORATOR"))
          and (.body | contains("<!-- factory:status -->") | not)))' \\
    | jq -r '"# " + .title + "\\n\\n" + .body + (if (.comments|length) > 0 then "\\n\\n## Comments\\n"
          + ([.comments[] | "\\n### " + .author.login + "\\n\\n" + .body + "\\n"] | join("")) else "" end)' \\
    > ${file}
  ${trustedIssueScript(String(issueNumber(n)))}
  ${parentSpecScript(String(issueNumber(n)), file)}
`;

/**
 * Appends the ticket's parent spec (its GitHub sub-issue parent) to a file. The spec's implementation decisions
 * bind every ticket, and the tickets do not repeat them. `issue` is a number or a shell variable such as "$issue".
 * A 404 means the issue has no parent. A parent that fails sf_issue_ok is left out with a note, and the ticket goes on. The endpoint was checked on 2026-11-12:
 * https://docs.github.com/rest/issues/sub-issues#get-parent-issue
 */
export const parentSpecScript = (issue: string, file: string) => `
  parent=$(gh api repos/${owner}/${repo}/issues/${issue}/parent --jq .number 2>/dev/null || true)
  case "$parent" in ''|*[!0-9]*) ;; *)
    ptext=$(gh issue view "$parent" --repo ${owner}/${repo} --json number,title,body \\
      --jq '"\\n\\n## Parent spec #" + (.number|tostring) + ": " + .title
            + "\\n\\nThis ticket builds part of this spec. Its decisions bind the ticket.\\n\\n" + .body')
    ${issueCheckFn}
    if sf_issue_ok "$parent"; then printf '%s\\n' "$ptext" >> ${file}
    else printf '\\n\\n## Parent spec #%s left out\\n\\nSomeone outside the repo wrote or changed it.\\n' "$parent" >> ${file}; fi ;;
  esac
`;

/**
 * An agent run with no Sandcastle script: Claude Code on a prompt file. The container is the sandbox
 * (no tokens, no LAN), the same as Sandcastle's noSandbox() on a CI runner. The caller writes the prompt file.
 */
export const promptAgent = (promptFile: string) => `claude -p "$(cat ${promptFile})" --dangerously-skip-permissions`;

type PrData = { head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string; repo: { default_branch: string } } };
/**
 * Why the factory must not touch this PR, or null. A fork's branch is not in our clone. A head that is the
 * base or default branch would make a push land there. Branch names go into shell scripts.
 */
export function prRefusal(data: PrData): string | null {
  if (data.head.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return `it comes from a fork (${data.head.repo?.full_name ?? "a deleted repo"})`;
  if ([data.base.ref, data.base.repo.default_branch].includes(data.head.ref)) return `its head branch \`${data.head.ref}\` is the base or default branch`;
  if (!/^[A-Za-z0-9._\/-]+$/.test(data.head.ref + data.base.ref)) return "its branch names contain characters the factory does not accept";
  return null;
}

/** The spec issue to /tmp/spec.md, read as data. */
export const specFileScript = (spec: number) => `
  gh issue view ${issueNumber(spec)} --repo ${owner}/${repo} --json title,body --jq '"# Spec: " + .title + "\\n\\n" + .body' > /tmp/spec.md
  ${trustedIssueScript(String(issueNumber(spec)))}
`;

/** Blockers from a ticket body's "## Blocked by" section (the sf convention, see docs/agents/issue-tracker.md). */
export function blockersFromBody(body = ""): number[] {
  const sec = body.match(/##\s*Blocked by\s*\n([\s\S]*?)(\n##\s|$)/i)?.[1] ?? body.match(/^Blocked by:(.*)$/im)?.[1] ?? "";
  return [...sec.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/** Project setup (npm ci, migrations, seed). The code may be agent-written, so this runs with no token. */
// npm clones a lockfile's git+ssh:// dependency with git, so url.insteadOf redirects it. Tested by hand on 2026-11-13
// with npm 12.2.1, SSH off and an empty cache. check: not yet tested with the runner image's npm.
export const setupScript = `${PRIVATE_DEPS.map((d) => ["ssh://git@github.com/", "git@github.com:", "https://github.com/"]
  .map((from) => `git config --global --add url.file:///work/deps/${d}.git.insteadOf ${from}${d}.git\n`).join("")).join("")}cd repo && ${SETUP}`;

/**
 * No token, inside repo/. Fails when the commits since `from` change GitHub Actions files. A pushed workflow
 * runs with the repo's Actions secrets, so the factory never pushes one. A person makes those changes.
 * An early message only: the agent can move refs and write /tmp. pushScript enforces the rule.
 */
export const noWorkflowChanges = (from: string) => `
  test -z "$(git diff --name-only ${from} HEAD -- .github/workflows .github/actions)" \\
    || { echo "The agent changed GitHub Actions files. The factory never pushes those. A person makes the change."; exit 1; }
`;

/** No token. Exit 1 if the agent left changes uncommitted or changed workflows, exit 3 if it made no commits. */
export const checkCommitsScript = `
  cd repo
  test -z "$(git status --porcelain)" || { echo "The agent left uncommitted changes."; exit 1; }
  ${noWorkflowChanges('"$(cat /tmp/base-sha)"')}
  test "$(git rev-list --count "$(cat /tmp/base-sha)"..HEAD)" -gt 0 || exit 3
`;

/**
 * The token step of a push. It never runs git inside the agent's repo: the agent can write repo/.git/config,
 * for example core.fsmonitor, which git runs. So it fetches HEAD into a fresh bare repo outside the volumes
 * and pushes from there.
 *
 * It is also where the Actions guard holds. A pushed workflow runs with the repo's Actions secrets, and every
 * check inside the agent's repo or /tmp reads what the agent can write. Here the guard compares the agent's
 * HEAD with `base`, fetched from GitHub: the branch the work started from ("HEAD" is the default branch).
 * Without a lease, the Actions files must match the base the agent started from. With a lease (a rebase), they must
 * match what git itself makes of that base merged with the branch on GitHub, rebuilt here from refs the agent cannot
 * write. A clean merge passes. A conflict leaves markers in the rebuilt file, so an agent's resolution is refused.
 */
/** `leaseSha`: push only if the branch is still at that commit. `force`: replace the branch (factory scratch branches). */
export const pushScript = (branch: string, { base, leaseSha, force }: { base: string; leaseSha?: string; force?: boolean }) => `
  git init -q --bare "$HOME/push.git" && cd "$HOME/push.git"
  git fetch -q /work/repo HEAD:refs/agent
  auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
  gh_git() { git -c core.hooksPath=/dev/null -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" "$@"; }
  gh_git fetch -q ${remote} ${base === "HEAD" ? "HEAD" : `refs/heads/${safeRef(base)}`}:refs/base
  want="$(git merge-base refs/base refs/agent)"
  ${leaseSha ? `gh_git fetch -q ${remote} refs/heads/${safeRef(branch)}:refs/old
  # Exit 1 means conflicts, and the tree still comes first. An empty tree fails the diff below, so the push stops.
  want="$(git merge-tree --write-tree "$want" refs/old | head -n1)" || true` : ""}
  git diff --quiet "$want" refs/agent -- .github/workflows .github/actions || { echo "The agent changed GitHub Actions files. The factory never pushes those. A person makes the change."; exit 1; }
  gh_git push -q ${leaseSha ? `--force-with-lease=refs/heads/${safeRef(branch)}:${sha(leaseSha)} ` : force ? "--force " : ""}${remote} refs/agent:refs/heads/${safeRef(branch)}
`;
const sha = (s: string) => { if (!/^[0-9a-f]{40}$/.test(s)) throw new NonRetriableError(`Not a commit sha: ${s}`); return s; };

/**
 * The token step that commits one file the agent wrote (for example /tmp/spec-notes.md) to a branch of its own,
 * replacing the branch. It runs in a fresh repo, so nothing the agent wrote runs here. The file is data.
 */
export const publishFileScript = (src: string, branch: string, name: string, message: string) => `${agentFiles}
  agent_file ${src} || { echo "${src} is missing, empty or not a plain file."; exit 1; }
  rm -rf "$HOME/pub" && git init -q -b main "$HOME/pub" && cd "$HOME/pub"
  cp ${src} ./${name}
  git -c user.name="agent-factory[bot]" -c user.email="agent-factory[bot]@users.noreply.github.com" add ${name}
  git -c user.name="agent-factory[bot]" -c user.email="agent-factory[bot]@users.noreply.github.com" commit -qm ${JSON.stringify(message)}
  auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
  git -c core.hooksPath=/dev/null -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \\
    push -q --force ${remote} HEAD:refs/heads/${safeRef(branch)}
`;

/** Check the agent's commits without the token, then push them with it. Returns false when there were none. */
export async function pushCommits(step: Step, runId: string, branch: string, opts: { base: string; force?: boolean }): Promise<boolean> {
  const made = (await step.run("check-commits", () =>
    docker.oneShot(runId, checkCommitsScript).then(() => true, (e: { code?: number }) => {
      if (e.code === 3) return false;
      throw e;
    }))) as boolean;
  if (made) await step.run("push", () => docker.oneShot(runId, pushScript(branch, opts), ghToken()));
  return made;
}

let slotQueue: Promise<unknown> = Promise.resolve();
/** Run fn after every earlier caller's fn has finished. */
function slotLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = slotQueue.then(fn, fn);
  slotQueue = next.catch(() => {});
  return next;
}

/**
 * Prepare the workspace, start the agent detached, and check it once a minute.
 * Every step is short, so a restart of the orchestrator never kills the agent.
 * `prepare` runs with the token and must not run project code. Pass null when the caller prepared the workspace.
 * `subject` names the work for `sf` status, for example "explore #4 #5", "implement #12" or "review PR #30".
 */
export async function runAgent(step: Step, runId: string, prepare: string | null, agentScript: string, subject: string, key?: string): Promise<void> {
  // A function that runs several agents gives each a key, so their step ids and containers stay apart.
  const id = (s: string) => (key ? `${key}:${s}` : s);
  const agent = key ? `${runId}-${key}` : runId;
  if (prepare !== null) {
    await step.run(id("prepare"), () => docker.oneShot(runId, prepare, ghToken()));
    await step.run(id("setup"), () => docker.oneShot(runId, setupScript));
  }

  // Wait for a machine slot, then start. Every run's steps execute in this one orchestrator process,
  // so a process-wide lock makes "count, then start" atomic: two runs cannot both take the last slot.
  for (let i = 0; ; i++) {
    const started = (await step.run(id(`start-agent-${i}`), () => slotLock(async () => {
      if (await docker.agentExists(agent)) return true; // a retry of this step after the start succeeded
      if ((await docker.runningAgents()) >= SLOTS) return false;
      await docker.startAgent(runId, agentScript, docker.agentEnv(runId), subject, agent);
      return true;
    }))) as boolean;
    if (started) break;
    if (i >= 120) throw new Error(`No free machine slot for 2 hours (FACTORY_SLOTS=${SLOTS}).`);
    await step.sleep(id(`wait-slot-${i}`), "1m");
  }

  let code: number | null = null;
  for (let i = 0; i < MAX_MINUTES && code === null; i++) {
    await step.sleep(id(`wait-${i}`), "1m");
    code = (await step.run(id(`check-${i}`), () => docker.agentExitCode(agent))) as number | null;
  }
  if (code === null) throw new Error(`The agent ran longer than ${MAX_MINUTES} minutes.`);
  if (code !== 0) throw new Error(`The agent exited with code ${code}.`);
}

/**
 * Shell helpers for token steps that read files the agent wrote in /tmp. A symlink to /proc/self/environ
 * would hand the token to gh as an attachment or a body, so only plain files whose real path is in /tmp count.
 * agent_file <path>: true for a non-empty plain file under /tmp. $attach: --attach flags for /tmp/evidence/*.png.
 * attach_for <paths...>: sets $attach for other paths, for example one issue's screenshots.
 */
export const agentFiles = `
  agent_file() { [ -f "$1" ] && [ -s "$1" ] && case "$(realpath -e "$1")" in /tmp/*) true ;; *) false ;; esac; }
  attach_for() { attach=(); local p; for p in "$@"; do agent_file "$p" && attach+=(--attach "$p"); done; return 0; }
  shopt -s nullglob; attach_for /tmp/evidence/*.png; shopt -u nullglob
`;

export const statusTag = " <!-- factory:status -->";

/** Runs when a run fails for good, also when the body could not run its own cleanup (for example, during a restart). */
export const resetOnFailure = (labelTarget: (data: Record<string, unknown>) => number | undefined) =>
  async ({ event }: { event: { data: { run_id: string; event: { data: Record<string, unknown> } } } }) => {
    const n = labelTarget(event.data.event.data);
    if (n) await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:in-progress" }).catch(() => {});
    await docker.cleanup(event.data.run_id);
  };
