# sf-kit: a self-hosted software factory

A coding agent writes code fast. It also writes slop. It has no judgment, and it sees only the task in front of it. Use one by hand, and your day turns into bug hunts, terminal juggling and live corrections.

Those are engineering problems, and they have engineering answers. sf-kit is a software factory that you run on your own machines. It follows Matt Pocock's course [Software Factories for Real Engineers](https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m). The course takes practices that work for large human teams, like domain language, deep modules and code review, and applies them to agents.

You do the part that needs a person. `sf` plans each idea with you until you agree on the design. Then it writes the spec and the tickets and gives them to the factory. Agents build the tickets in Docker containers, and a second agent reviews each PR. You return to PRs that are ready for your review, and you merge.

| Agents by hand | Agents in sf-kit |
| --- | --- |
| You find the bugs in every diff. | A review agent reads each PR against its ticket and your coding standards first. |
| You watch terminals and steer the agent live. | Agents work in the background. `sf` stops only when a PR is ready, a ticket needs a decision, a prototype is ready or a run failed. |
| You run one task at a time. | Many agents work at the same time, across your repos and your machines. |
| Your time goes to bug fixes. | Your time goes to the plan and the decisions. |

```mermaid
flowchart LR
    idea([Your idea]) --> sf["sf<br/>plan with you"]
    sf --> gh[("GitHub<br/>spec, tickets")]
    gh -- "labels, comments" --> orch["Orchestrator<br/>+ Inngest"]
    orch -- "starts" --> runner["Runner containers<br/>Claude Code agents"]
    runner -- "commits" --> orch
    orch -- "branches, PRs,<br/>comments" --> gh
    gh -- "PR ready" --> you([You review<br/>and merge])
```

## What makes the factory work

The course draws a software factory as two paths from the team to the agent. This map follows that picture, with the sf-kit part in each box.

```mermaid
flowchart BT
    team["<b>The team</b><br/>you: plan, decide, merge"]
    know["<b>Knowledge</b><br/>GLOSSARY.md, ADRs,<br/>CODING_STANDARDS.md, specs"]
    brakes["<b>Brakes</b><br/>checks, review agent,<br/>your review"]
    infra["<b>Infrastructure</b><br/>factory host, worker machines,<br/>runner containers"]
    accel["<b>Accelerators</b><br/>labels, night shift,<br/>scheduled tasks"]
    agent["<b>The agent</b><br/>Claude Code in a container"]
    team -- grows --> know -- creates --> brakes -- "slows down" --> agent
    team -- builds --> infra -- creates --> accel -- "speeds up" --> agent
```

| Box | What it is | What sf-kit gives you |
| --- | --- | --- |
| The team | The people who think about strategy | `sf` plans each idea with you. Nothing merges without your two yes answers. |
| Knowledge | Shared language and good software fundamentals | Grilling writes `GLOSSARY.md` and ADRs. The implementer adds new terms. The reviewer adds rules to `CODING_STANDARDS.md`. |
| Brakes | Checks and review that slow the agent and raise quality | A pre-commit hook runs your checks on each agent commit. CI runs the full check. A review agent reads each PR, and it never approves. |
| Infrastructure | Sandboxes and scripts that let agents work while you are away | One host for all your repos, worker machines for more agents, and a new container with no GitHub token for each run. |
| Accelerators | Triggers and schedules that start agents with no person | Labels start explore, implement and the night shift. Schedules start ratchet, rebase and architecture review. |
| The agent | The model and harness that write the code | Claude Code, inside a firewall. See [Security](docs/security.md). |

**Brakes first.** The course warns that most people start with accelerators, and calls that backwards. sf-kit follows its order. `init-project.sh` adds the knowledge files and the checks before any agent runs. Before a build, `sf` checks that `GLOSSARY.md`, `CODING_STANDARDS.md` and `docs/` are committed and on GitHub, because the agents clone from there.

### Below the waterline

The course shows good results as the tip of an iceberg. Under the water are three layers: how models work, how harnesses work, and the environment of your agent. You choose the model and the harness. sf-kit builds the third layer.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1786640503/workshops/ai-coding-crash-course/iceberg-dark.png">
    <img width="360" alt="Iceberg: great, reliable, predictable results above the waterline. Below it: how models work, how harnesses work, and your agent's environment." src="https://res.cloudinary.com/total-typescript/image/upload/v1786640502/workshops/ai-coding-crash-course/iceberg-light.png">
  </picture>
  <br><sub>Image: Matt Pocock, <a href="https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m">AI Hero</a>.</sub>
</p>

Each agent starts in the same environment. It gets the runner image with a browser and rtk, an activity hook and your pre-commit checks. Its ticket ends with its parent spec.

### When to use the factory

The course says a factory suits routine ticket work. New projects, exploratory work and the complex parts of a system still work best with you and one agent in a loop. `sf` covers both: it plans with you first, then gives the routine tickets to the factory.

## Many repos, many machines

```mermaid
flowchart LR
    laptop["Your laptop<br/>sf"] -- "events" --> host
    subgraph host ["Factory host"]
        inngest["Inngest"]
        fa["factory app-a"]
        fb["factory app-b"]
        local["agents"]
    end
    ga[("repo app-a")] <--> fa
    gb[("repo app-b")] <--> fb
    host -- "ssh" --> w1["Worker machine<br/>agents"]
    host -- "ssh" --> w2["Worker machine<br/>agents"]
```

**One factory for each repo.** A factory host runs one factory for each of your repos. Each factory has its own name, port, GitHub token and event names. All factories share one Inngest server, one runner image and the agent slots. To add a repo, run `./setup-wizard.sh --repo owner/name`.

**Agents on several machines.** `FACTORY_MACHINES` lists the machines that run agents, with a slot count for each:

```bash
FACTORY_MACHINES="local=2 ssh://factory@linux-box=3"
```

Each run picks the machine with the smallest share of busy slots, and keeps it to the end. The host reaches each worker machine over ssh. A worker machine holds no factory config. To add one, run `init-worker.sh` on it. The runner image builds on amd64 and arm64.

**`sf` from any machine.** `sf` can drive factories on other hosts. Put their addresses in `~/.config/sf`, and one laptop drives factories on several hosts. Each repo still has exactly one factory host.

[Set up a factory host](docs/setup.md) has the details: [one factory per repo](docs/setup.md#one-factory-per-repo), [worker machines](docs/setup.md#worker-machines) and [`sf` on another machine](docs/setup.md#sf-on-another-machine).

## Quick start

```bash
# 1. Prepare the factory host, once. The dry run shows each change first.
./init-host.sh --observability phoenix --dry-run
./init-host.sh --observability phoenix

# 2. Add a factory for each repo.
./setup-wizard.sh

# Optional: on each worker machine, then add it to FACTORY_MACHINES.
# ./init-worker.sh --key "$(ssh <factory host> cat .ssh/id_ed25519.pub)" --dry-run

# 3. Put sf on your PATH.
ln -s "$PWD/sf" ~/.local/bin/sf

# 4a. Start a new project.
cd ~/code && sf new my-app "<what you want to build>"

# 4b. Or prepare an existing project. Add --dry-run first to see the changes.
./init-project.sh --path ~/code/my-app --labels
(cd ~/code/my-app && npm i -D @ai-hero/sandcastle@^0.14 tsx zod@^3.25)
cd ~/code/my-app && sf idea "<what you want to build>"
```

Each script prints its next steps at the end. Run the scripts as your own user, not with `sudo`.

## Read next

| Doc | Read it when you want to |
| --- | --- |
| [Set up a factory host](docs/setup.md) | install the host, add repos, add worker machines, use `sf` from a laptop, or open the dashboards |
| [Use `sf`](docs/sf.md) | plan an idea, start the build, read the board, or follow one agent |
| [What the factory runs](docs/factory.md) | know what each label starts and what each task does |
| [Security](docs/security.md) | know what an agent can reach and whose issues it follows |

## What is in this folder

| Path | What it does |
| --- | --- |
| `sf` (`cli/sf.mjs`) | The pipeline CLI. It takes an idea from planning to merged pull requests, and shows the runs and the agents. |
| `init-host.sh` | Prepares the factory host once. It installs Inngest, Postgres, Redis, optional Phoenix, the run network, the firewall rules and the runner image. It starts no factory. |
| `setup-wizard.sh` | Adds or edits one factory. Run it once for each repo. |
| `init-worker.sh` | Makes a machine a worker machine. A worker machine runs agents for a factory host. |
| `init-project.sh` | Makes a project ready for the factory. It never overwrites a file. |
| `orchestrator/` | The Node app. It turns GitHub events into Inngest events, and its functions run the agents in Docker. |
| `host/` | The compose file, the runner Dockerfile, the Caddyfile, the firewall script and the systemd units. |
| `project-template/` | The files that `init-project.sh` copies into a project. |
| `herdr-plugin/` | An optional [herdr](https://herdr.dev) plugin. It opens a pane that follows one agent. |
