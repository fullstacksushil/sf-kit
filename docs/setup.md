# Set up a factory host

A factory host runs the shared services and one factory for each repo. Worker machines can run more agents for it. This page covers the install, the layout of the factories, worker machines, `sf` on a laptop, GitHub events and the dashboards.

## Requirements

- **Factory host:** Docker with the compose plugin, Node 22 or later, `sudo`, and a user in the `docker` group.
- **Factory host:** `flock` from util-linux. The factories share the slots of each machine through `flock` locks: one for each machine, and one for the pick.
- **Worker machine:** Linux Docker with the `DOCKER-USER` iptables chain, and `sudo`. Docker Desktop does not work. The factory host connects with `ssh`, so the orchestrator user needs an ssh key.
- **Each project:** `npm i -D @ai-hero/sandcastle@^0.14 tsx zod@^3.25`. The agent scripts import all three.
- **`init-project.sh`:** `gh` for `--labels`. The script copies the skills and agent scripts from a clone at `../cohort-005-project`. The clone needs the `live-run-through` branch.
- **`sf`:** Node 22 or later, `gh` with a signed-in account, and `claude`.
- **The herdr plugin (optional):** herdr 0.9.1 or later, `fzf` and Node.

## Install

```bash
./init-host.sh --observability phoenix --dry-run
./init-host.sh --observability phoenix
./setup-wizard.sh                  # once for each repo
```

**`init-host.sh`** prepares the host once. It installs Inngest, Postgres, Redis and optional Phoenix. It adds the run network, the firewall rules, the runner image and the template unit for the factories. It writes the shared env file and starts no factory. It never overwrites a secret.

Run `init-host.sh` as your own user, without `sudo`. The script calls `sudo` for the steps that need it. The factory services run as the user who runs the script. With `sudo`, that user is `root`. Then no agent run starts, because the service cannot open the slot locks `/tmp/factory-slots-*.flock` that your user owns. The script stops with a message when you run it with `sudo`.

**`setup-wizard.sh`** adds or edits one factory. It asks for the repo, the factory name, the GitHub token, the port, the firewall rule, the start, and webhook or polling. The first run also asks for the Claude token and optional Langfuse keys. The wizard checks each value.

A project that is not plain Node needs two more values. The wizard asks for a setup command (`RUN_SETUP`) and a runner image (`RUNNER_IMAGE`). Both are optional, and each factory has its own values. Build the image from `factory-runner:latest` and add the tools of the project.

**`host/`** holds the files that `init-host.sh` installs, and the Caddyfile, which you install yourself:

- `compose.yaml` runs Inngest, Postgres, Redis and Phoenix.
- `runner.Dockerfile` builds the image of every agent container.
- `factory-firewall.sh` and `factory-firewall.service` add the rules of the run network at each boot. No factory starts without this unit.
- `factory-orchestrator@.service` is the systemd template unit for the factories.
- `Caddyfile` has a webhook site and two dashboard sites behind basic auth.

To deploy a new version of the kit, run `./init-host.sh` again. Then restart every factory: `sudo systemctl restart 'factory-orchestrator@*'`.

### A new project

`sf new my-app "<idea>"` makes a React Router, TypeScript and Vitest app. The agent prompts expect this stack. `sf new` adds the agent files and two scripts that the agents run: `npm run check` (types, then tests) and `npm run build`. It runs both and makes the first commit. Then it asks before it creates the private GitHub repo and the factory labels. At the end, it prints the `setup-wizard.sh --repo` command for the new repo.

### An existing project

`init-project.sh --path <repo> --labels` adds the agent guide files, the tracker doc, the skills and the agent scripts. It never overwrites a file. It copies these files from `project-template/`:

- `AGENTS.md`, `GLOSSARY.md` and `CODING_STANDARDS.md`
- the tracker doc and the PR template
- the pre-commit hook `.githooks/pre-commit`, with `scripts/check-file-tokens.mjs`
- the CI workflow `.github/workflows/check.yml`

`npm install` turns the hook on, in your clone and in the clone of each agent. The hook runs `npm run check:fast` when the project has it, else `npm run check`. CI runs the full check. Keep `check:fast` to a few seconds, because agents commit often.

## One factory per repo

One factory host runs one factory for each repo. All factories share one Inngest server, one runner image, one run network and one list of machines with their slots. Each factory has its own name, Inngest app, event names, port, env file, GitHub token and systemd unit.

| Item | Where |
| --- | --- |
| Factory name | Lowercase letters, digits and dashes. It starts with a letter and has 21 characters at most. The wizard proposes one from the repo name. |
| Shared env file | `/etc/factory/common.env`: the Inngest settings and keys, `CLAUDE_CODE_OAUTH_TOKEN`, `FACTORY_SLOTS`, `FACTORY_MACHINES` and the trace settings |
| Factory env file | `/etc/factory/factories/<name>.env`: `GITHUB_REPO`, `FACTORY_PAT`, `PORT`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_POLL` and the other values of one repo. A value here wins over the shared file. |
| systemd unit | `factory-orchestrator@<name>.service`. The unit sets the factory name, so no env file can change it. |
| Inngest app | `software-factory-<name>` |
| Event names | `factory/<name>/<event>`, for example `factory/qf/ratchet.requested` |
| Port | The wizard picks the highest saved port plus 1, from 3000. The firewall lets Inngest reach ports 3000 to 3099. |

`sf` finds the factory whose `GITHUB_REPO` matches the git origin of the folder. If no factory serves the repo, `sf` offers to run the wizard. `sf` searches `~/.config/sf` first, then `/etc/factory`. Set `ENV_DIR` to a colon-separated list of folders to search instead. Set `SF_ORCHESTRATOR_URL` and `SF_FACTORY` to skip the search and name one factory.

Limits of the shared host:

- All factories share the run network `factory-net`. An agent of one factory can reach a server that an agent of another factory started. Give each factory its own `RUNNER_NETWORK` before a factory serves a public repo.
- The slots of a machine are one cap for every factory on it, with no fair share. One factory can hold every slot.
- Private GitHub dependencies: the wizard saves `RUN_PRIVATE_DEPS="owner/repo ..."` in the factory env file. It checks that `FACTORY_PAT` can read each one. The token step clones each one, and setup installs from those clones with no token. Nobody tested this with the npm of the runner image yet.

## Worker machines

`FACTORY_MACHINES` in `common.env` lists the machines that run agents, with a slot count for each: `local=2 ssh://factory@linux-box=3`. `local` is the factory host. Without `FACTORY_MACHINES`, the list is `local` with `FACTORY_SLOTS` slots. A bad list stops each factory at its start.

### Add a worker machine

1. On the worker machine, run this as your own user. Read the dry run, then run it again without `--dry-run`.

   ```bash
   ./init-worker.sh --key "$(ssh <factory host> cat .ssh/id_ed25519.pub)" --dry-run
   ```

   The script adds a worker user that accepts the ssh key of the factory host. It adds the run network with the firewall rules, and it builds the runner image. It refuses Docker Desktop, because the firewall rules cannot apply inside its VM.
2. Follow the next steps that the script prints. They check the ssh connection and add the machine to `FACTORY_MACHINES`.
3. Build the runner image on the worker machine again each time `host/runner.Dockerfile` changes.

To take a machine out of the list, set its slots to 0 first. Remove it when its runs end.

### How a run picks a machine

Each run picks one machine at its start and keeps it to the end, because its volumes stay on that machine. A run never moves to another machine.

- The pick takes the machine whose runs hold the smallest share of its slots. It also counts the runs that only prepare.
- A machine that does not answer gets no new runs. A machine with 0 slots gets no new runs either, and its runs finish there one agent at a time.
- An agent waits up to 2 hours for a free slot on its own machine, even when another machine has a free slot.

### When a machine does not answer

While the machine of a run does not answer, its agent counts as still running. That lasts up to the maximum run time, `RUN_MAX_MINUTES` (45 by default). Any other step of that run fails.

An agent stops itself 5 minutes after the maximum run time. This also works on a laptop that the orchestrator could not reach for a while. Cleanup logs what it cannot remove.

The orchestrator marks a machine for a sweep when it starts, and each time a call to the machine does not answer. The next pick that gets an answer from a marked machine sweeps it. The sweep removes the containers and volumes of runs that Inngest no longer runs or queues, if they are older than an hour. The mark stays while younger leftovers wait. The sweep removes nothing when Inngest does not say that its list of active runs is complete.

### What changes on a worker machine

- Every agent carries the label `factory.machine`, with `local` or the host name.
- A failure message of the agent names the machine.
- The agent sends no traces.
- `sf` and the herdr plugin read only the Docker of their own machine. They do not show agents on a worker machine. Watch those runs in the Inngest dashboard.

The runner image builds on amd64 and arm64. Chrome for Testing has no Linux arm64 build, so on arm64 the image uses Debian's Chromium.

## `sf` on another machine

`sf` can run on a machine that is not the factory host. Make the folder `~/.config/sf` on that machine, with two files:

- `factories/<name>.env`: `GITHUB_REPO`, and `ORCHESTRATOR_URL` with the public address of the host. It needs no `PORT`.
- `common.env`: `INNGEST_BASE_URL` and `INNGEST_EVENT_KEY` of the host.

For an Inngest dashboard behind basic auth, put the user and the password in the URL: `https://<user>:<password>@<host>`. Percent-encode the password. `sf` sends them as a header and never prints them.

`sf` searches `~/.config/sf` first, then `/etc/factory`. So one machine can use its own factories and factories on other hosts. For factories on several hosts, put `INNGEST_BASE_URL` and `INNGEST_EVENT_KEY` in each factory file. A value in a factory file wins over `common.env`.

Give the files mode 600. The board then shows the runs of the host. It shows no agents, and `sf logs` finds none, because both read the Docker of the local machine.

## Webhook or polling

The orchestrator gets GitHub events from a webhook, or it polls GitHub.

- **Webhook:** GitHub calls the orchestrator at once. This needs a public URL. Each factory gets its own path, `/webhooks/<factory name>`. `host/Caddyfile` sends each path to the port of its factory.
- **Polling:** set `GITHUB_POLL=1` in the factory env file. A cron function checks the trigger labels and new prototype feedback once a minute. Use it on a laptop with no public URL.

You can use both. The webhook starts each run at once. Polling finds a label that GitHub sent while the host was down.

Polling is up to a minute slower. It makes one API call a minute for each trigger label, and one for each open prototype issue. The token allows 5,000 calls an hour. Duplicate events are safe, because each task removes its trigger label at the start and skips repeats.

The webhook stage of the wizard sets `GITHUB_POLL=0`. To use both, set `GITHUB_POLL=1` again and restart the factory.

## Dashboards

The Inngest and Phoenix dashboards listen on localhost only. You can reach them from another machine in two ways:

- **SSH tunnel:** `ssh -L 8288:localhost:8288 -L 6006:localhost:6006 <you>@<host>`. No port opens.
- **Caddy with basic auth:** `host/Caddyfile` has one site for each dashboard. Each site needs a DNS name that points to the host, and ports 80 and 443 must be open. Make the password hash with `caddy hash-password`.

The Inngest dashboard has no sign-in of its own. A person who passes the basic auth prompt can start and cancel runs. Phoenix asks for its own sign-in after the prompt.

Tested on 2026-11-16 with Caddy 2.11 and Chrome: Inngest answers 401 on `/dev`, a path that its dashboard reads. The browser then discarded the password and showed the prompt again, with no end. The Inngest site in `host/Caddyfile` changes these 401 answers to 403.

## Memory and image size

- A run container gets 4 CPUs and 8 GB of memory. Set `RUNNER_CPUS` and `RUNNER_MEMORY` in a factory env file to change the limits of that factory.
- Nothing checks that the slots of a machine fit in its memory. When a run passes its limit, the kernel stops one process in the container. The run then fails with an unclear message.
- To find the memory that a project needs, run its setup and its check in the runner image with `--memory <limit> --memory-swap <limit>`. The check must pass, and `/sys/fs/cgroup/memory.events` in the container must show `oom_kill 0`. Do not read `memory.peak` for this. It includes the file cache, and the file cache fills the limit.
- The runner image is about 3.2 GB, because it holds Chrome for screenshots, or Chromium on arm64.
- The runner image holds [rtk](https://github.com/rtk-ai/rtk). A hook gives each Bash call of the agent to rtk, which shortens the output of commands like git, npm and grep. An image without rtk skips the hook.
