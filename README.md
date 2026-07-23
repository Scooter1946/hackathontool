# teamctx

**Shared team context for Claude Code.** One teammate turns their machine into a team server with a
single command; everyone else SSHes in over Tailscale and runs their own unmodified `claude` session,
authenticated with their own Claude subscription. Every session is wired into a shared **MCP context
server** — a team-wide memory where each person's agent posts findings ("this API is rate-limited"),
logs decisions ("we switched the schema"), and sees who's working on what.

> Working name. Rename freely.

---

## Overview — everything, at a glance

teamctx is **two deliverables plus the glue that installs them**:

1. **The MCP context server** (`packages/server`) — the differentiator. A small Node service on the
   host's loopback interface, backed by SQLite, exposing 7 MCP tools so that different humans' Claude
   Code agents share one live memory. Nothing else on the market makes Alice's agent aware of what
   Bob's agent just learned.
2. **The provisioner CLI** (`packages/cli`, the `teamctx` command) — one command for the hoster to
   turn their machine into the team server and print invites, and one for teammates to join.

Everything the project contains:

- **`teamctx host / join / stop / teardown`** — provision, connect, pause, and cleanly remove.
- **A safe dry-run by default.** `host` renders every file and prints every privileged command
  without touching the machine. `--execute` (as root) applies for real.
- **An interactive wizard.** Run `teamctx host` with no flags for a guided setup: preflight → repo &
  usernames → dry-run review → apply (or a ready-to-paste `sudo … --execute`).
- **Two isolation modes.** The default **host mode** runs each session directly on the machine under a
  locked-down Unix account; the optional **container mode** (`--isolation container`) jails each
  session inside a Linux box that can see nothing but the shared folder.
- **A shared team folder** (`/team`) — a `CLAUDE.md`, an `.mcp.json` pointing every session at the
  context server, and a `SessionStart` hook that injects the latest team digest into each new session.
- **Per-user git branches.** The shared repo is cloned into `/team/repo`; each teammate is auto-allocated
  their own branch (`teamctx/<user>`) and worktree on first connect, so they work independently.
- **Own-account everything.** Each person logs in with their own Claude plan and (via a one-time
  `gh auth login`) commits/pushes under their own GitHub account. teamctx never sees a credential.
- **Standard-OS security.** Separate non-admin users, `0700` homes, a group-owned shared folder,
  machine-wide managed settings, an sshd `ForceCommand` with no shell escape and no forwarding, and
  Tailscale-only connectivity — never the public internet.
- **Tested and CI-gated.** 82 tests on macOS + Linux; typecheck, ESLint, and Prettier all clean.

**Status:** the whole pipeline works and is tested in **dry-run**. The privileged `--execute` path
(and container mode's Docker build) are code-complete but **have not yet run on a real machine** — see
[STATUS.md](STATUS.md) and [VERIFICATION.md](VERIFICATION.md).

**How it fits together, in one picture:**

```
Hoster's machine (macOS first, Linux second)
├── teamctx CLI  ── host / stop / teardown / join
├── MCP context server → 127.0.0.1 (SQLite storage)         ← the shared team memory
├── /team/                                                   ← group-owned shared folder
│   ├── CLAUDE.md            team rules
│   ├── .mcp.json            points every session at the context server
│   ├── .claude/…            SessionStart hook → injects the team digest
│   └── repo/ + worktrees/<user>/   shared clone; each teammate on their own branch
├── managed-settings.json    machine-wide: grant /team, deny sudo, pre-approve the MCP server
├── sshd: Match Group teamctx → ForceCommand → (host mode) claude  |  (container mode) enter the box
└── Tailscale: tailscale up --ssh   (tailnet identity replaces passwords/keys)

Teammate:  join the tailnet → ssh://<user>@<host>  →  lands directly inside their own Claude session
```

---

## Table of contents

- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Isolation modes](#isolation-modes)
- [The context server](#the-context-server)
- [The team folder](#the-team-folder)
- [Per-user branches & GitHub auth](#per-user-branches--github-auth)
- [Security model](#security-model)
- [Hard constraints — not allowed](#hard-constraints--not-allowed-legal--tos)
- [Commercial-use disclaimer](#commercial-use-disclaimer)
- [Project status](#project-status)
- [Repo layout](#repo-layout)
- [Development](#development)
- [Language / stack decision](#language--stack-decision)

---

## How it works

The problem: for a hackathon-style team, no existing product lets several people's **separate** Claude
Code sessions share live context, and nothing is "spin up in ten minutes on someone's laptop." teamctx
fills exactly that gap, and deliberately **does not** build an agent runtime, a custom Claude UI, or
any auth/billing — those would cross the line into Anthropic's proprietary surface (see the
[hard constraints](#hard-constraints--not-allowed-legal--tos)).

The design instead composes two things that are entirely ours to build:

**1. A shared memory.** The context server is a normal Node process listening on `127.0.0.1`. Every
Claude Code session on the host connects to it as an MCP server (declared in `/team/.mcp.json`). Agents
call tools like `post_finding` and `get_context`; the data lives in one SQLite database under `/team`,
so it is genuinely shared across everyone. A `SessionStart` hook additionally fetches a digest of
recent activity and injects it into each new session, so a fresh agent starts already aware of the
team's latest findings and decisions.

**2. A shared host.** Everyone's `claude` runs on the **one** host machine, reached over SSH. That is
what makes the shared filesystem and the loopback context server possible: teammates don't run Claude
on their own laptops pointing at a remote server — they run it _on the host_, each under their own Unix
account, each in their own git worktree. sshd is pinned so the `teamctx` group can only ever land in
Claude Code (no shell, no forwarding), and Tailscale — never the public internet — carries the
connection and supplies identity.

A session's lifecycle, end to end:

```
teammate runs:  ssh <user>@<host-magicdns>
      │
      ▼
sshd (Match Group teamctx) → ForceCommand
      │
      ├─ host mode ─────────► teamctx-shell → allocate branch/worktree → gh auth (first time) → exec claude
      │
      └─ container mode ────► bridge → sudo teamctx-enter → docker exec into the box → teamctx-shell → exec claude
      │
      ▼
Claude Code starts. First run: the human logs in with THEIR OWN Claude account (URL + paste-code).
The SessionStart hook injects the team digest. .mcp.json connects the session to the context server.
```

Only the **hoster** ever runs the `teamctx` CLI. Teammates install nothing beyond Tailscale — the
shared tools and the auto-injected digest just work once they connect.

---

## Quickstart

> `teamctx host` mutates the machine (creates users, edits sshd, writes system settings, and in
> container mode builds a Docker image). It runs a **safe dry-run by default** — rendering every file
> and printing every privileged command without applying anything. Add `--execute` (as root) only on a
> host you mean to provision, ideally a throwaway VM first (see [SECURITY.md](SECURITY.md)).

### Hoster

The fastest start is the **interactive wizard** — run `teamctx host` with no flags. It checks your
tools, asks for the repo and teammate usernames, whether to jail teammates in a container, renders the
full dry-run for review, then prints the exact `sudo … --execute` command to apply (or applies it
directly if you're already root):

```bash
teamctx host                 # interactive setup wizard — safe dry-run, prints the apply command
```

Prefer flags? Drive it non-interactively:

```bash
# Preview exactly what would be provisioned — writes nothing to the system:
npx teamctx host --users alice,bob --repo https://github.com/you/project.git

# Apply for real (root; validate on a throwaway VM first — see SECURITY.md):
sudo teamctx host --users alice,bob --repo https://github.com/you/project.git --execute
```

**Hard isolation (optional):** add `--isolation container` to run every teammate's session inside a
single Linux "box" container that mounts only `/team` (plus any `--expose <host>[:box][:ro]`). From
inside, `ls /` shows nothing of the host — a real OS boundary, not just an agent guardrail. Needs
Docker or OrbStack on the host; `stop` / `teardown` take the same `--isolation container` flag.

`host` starts the context server (supervised), clones your repo into `/team/repo`, stamps `/team`,
creates locked-down guest accounts, writes machine-wide managed settings that pre-approve the context
server, restricts the `teamctx` SSH group to Claude Code via `ForceCommand`, brings up Tailscale, and
prints a per-teammate invite (tailnet step + `ssh://` link + QR code).

Pause or remove hosting (add `--isolation container` if you hosted that way):

```bash
teamctx stop --execute                          # disable guest SSH + stop the server; keep all data
teamctx teardown --users alice,bob --execute    # remove everything; archive /team to a tarball
```

### Teammate

You only need the invite. Join the tailnet, then connect — a plain SSH lands you straight in Claude
Code (thanks to the `ForceCommand`), so no teamctx install is required:

```bash
ssh <user>@<host-magicdns-name>
```

`teamctx join ssh://<user>@<host>` is an optional convenience that brings up Tailscale and opens the
link for you. Either way, on first connect Claude asks you to log in with **your own** Claude account
(a URL + paste-back code) — teamctx never sees your credentials — and a one-time `gh auth login`
attributes your commits to your own GitHub account. From there you're on your own branch's worktree,
with the shared tools (`get_context`, `post_finding`, …) and the auto-injected team digest.

**Claude desktop app (optional):** instead of the terminal, add the host as an SSH connection in the
app's environment dropdown for one-click reconnects. Claude Code executes on the host, so the same
managed settings and isolation apply.

---

## Isolation modes

teamctx gives every teammate an unprivileged account and confines the _agent_ to `/team` via managed
settings. The two modes differ in how hard the filesystem boundary is.

### Host mode (default)

Sessions run directly on the host. Isolation is standard multi-user Unix, layered:

- **Separate non-admin users**, each with a `0700` home no one else can read.
- **A group-owned shared folder.** `/team` is owned by the `teamctx` group with the setgid bit
  (`2775`), so teammates share it while staying out of each other's homes.
- **Machine-wide managed settings** grant Claude Code access to `/team`, deny `sudo`/`su`, and
  pre-approve the context server so sessions connect with no trust prompt.
- **An sshd `ForceCommand`** that drops the group straight into Claude Code — no interactive shell, and
  TCP / agent / X11 forwarding and tunnels all disabled.

This is enough to keep teammates out of each other's private data and off `root`, but it is **not** a
container: a teammate's agent is still a process on your machine and can read world-readable files
(like any Unix user). Invite only people you'd hand a normal SSH account.

### Container mode (`--isolation container`)

For a hard boundary, teammates' sessions run inside one long-lived Linux **box** container:

- **`ls /` shows only what you mounted** — `/team`, a private per-user home, and any `--expose`'d
  paths. The host's files do not exist in that filesystem view. This is an OS boundary, not a guardrail.
- **Claude Code is installed unmodified** from Anthropic's official signed apt repo; the container only
  _confines_ it (keeping us clear of [Hard Constraint #1](#hard-constraints--not-allowed-legal--tos)).
- **The context server runs inside the box**, so `docker exec`'d sessions reach it on `127.0.0.1` with
  no change to `.mcp.json`.
- **Tokens stay private.** Per-user homes mount from `/var/lib/teamctx/homes/<user>` (`0700`), outside
  the group-readable `/team`, so each person's Claude/`gh` credentials are isolated.
- **The host is protected.** Only `/team` + homes (+ exposes) are mounted — never the Docker socket.
  Capabilities are dropped, privilege escalation is disabled, and no port is published. Teammates get
  no host Docker access: a scoped-sudo bridge (`teamctx-enter`, identity from `$SUDO_USER`) is the only
  privileged thing the `ForceCommand` can invoke.

The image builds the context server (its `better-sqlite3` native module) inside the container so it
matches Linux/arch, then installs `git`, the GitHub CLI, and Claude Code. Requires Docker/OrbStack on
the host.

---

## The context server

A `McpServer` (MCP TypeScript SDK) over Streamable HTTP, bound to `127.0.0.1`, storing everything in
SQLite. It registers seven tools:

| Tool           | Purpose                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| `post_finding` | Record something learned ("the staging DB is read-only").                  |
| `get_context`  | Read recent findings + decisions, attributed to who posted them.           |
| `log_decision` | Record a team decision ("we're using Postgres, not SQLite").               |
| `claim_task`   | Take ownership of a shared task.                                           |
| `release_task` | Hand a task back.                                                          |
| `list_tasks`   | See the shared task board and who holds what.                              |
| `get_digest`   | A compact summary of recent activity (also used by the SessionStart hook). |

Identity is a self-declared `X-Teamctx-User` header derived from the caller's Unix username. On
loopback that's a label, not a security boundary — the real boundary is the OS user separation. The
server is supervised by launchd (macOS) or a systemd user unit (Linux) in host mode, or by the
container's restart policy in container mode. Configuration is env-driven (`TEAMCTX_PORT`,
`TEAMCTX_DATA_DIR`).

---

## The team folder

`teamctx host` stamps `/team` from a template:

- **`CLAUDE.md`** — team rules (check context before starting, post findings after; you're on your own
  branch `teamctx/<you>`).
- **`.mcp.json`** — points every session at `http://127.0.0.1:${TEAMCTX_PORT}/mcp` with the
  `X-Teamctx-User` header. Uses env expansion so it's identical for everyone.
- **`.claude/settings.json`** — a `SessionStart` hook (matcher `""`, so it covers startup / resume /
  clear / compact) that runs the digest script and injects its output into the session's context.
- **`.claude/hooks/session-digest.sh`** — curls `/digest` from the context server; degrades gracefully
  (prints nothing) if the server is down.

---

## Per-user branches & GitHub auth

The shared repo is cloned into `/team/repo` (or an empty repo is initialized). It's made usable by
every teammate's Unix account with `safe.directory` and `core.sharedRepository=group`. On first
connect, the `ForceCommand` shell lazily allocates each teammate a branch `teamctx/<user>` and a
worktree at `/team/worktrees/<user>`, so everyone works independently and shares by pushing or opening
PRs.

Commits are attributed to each person's **own** GitHub account (Model A): the first connect runs a
one-time `gh auth login` (device/paste-code flow, only when the repo's remote is on GitHub) and
`gh auth setup-git`, then sets the git identity from `gh api user` using the privacy-preserving
`<id>+<login>@users.noreply.github.com` email. No SSH key setup, and teamctx never holds the token —
`gh` stores it in the teammate's own `0700` home.

---

## Security model

Isolation is built entirely from standard OS primitives and Claude Code's own configuration surfaces —
teamctx never modifies Claude Code and never touches anyone's credentials. Read
**[SECURITY.md](SECURITY.md)** for the full model and, importantly, what it does **not** protect
against (in host mode, a hostile teammate is still a process on your machine; the shared `/team` has no
per-user secrecy; the loopback header identity is not a boundary; `--execute` is powerful). Container
mode hardens the filesystem boundary but should still be validated on a throwaway VM before real use —
see **[VERIFICATION.md](VERIFICATION.md)** for what CI checks automatically and the manual VM checklist
for the privileged path.

---

## HARD CONSTRAINTS — NOT ALLOWED (legal / ToS)

Violating any of these invalidates the project. When in doubt, choose the design that keeps us further
from these lines.

1. **NEVER** modify, fork, re-skin, wrap, patch, or inject into the Claude Code binary or its UI.
   Claude Code is proprietary (Anthropic Commercial ToS, not open source). All customization must be
   pure configuration: managed settings, CLAUDE.md, hooks, `.mcp.json`, skills, shell/sshd config.
2. **NEVER** touch users' Claude credentials. Do not collect, store, copy, proxy, forward, read, or
   programmatically use anyone's OAuth token, `~/.claude` contents, or session credentials. Consumer
   (Free/Pro/Max) OAuth tokens may not be used "in any other product, tool, or service" — our product
   must stay entirely out of the auth path. Each human runs `claude` themselves and logs in themselves.
3. **NEVER** programmatically drive Claude Code sessions on users' behalf (no headless `-p`
   invocations, no Agent SDK calls, no expect/pty scripting of the `claude` binary) using consumer
   accounts. If a server-side agent feature is ever wanted, it requires an API key the hoster pays for —
   out of scope for v1.
4. **NEVER** auto-complete the user's Claude login. The first-run OAuth (URL + paste-code, ~30s) must
   be performed by the human. We may print instructions; we may not automate it.
5. **No malicious or invasive capability on the host machine.** Guest accounts get no sudo, no access
   outside the team folder (Unix permissions: guest homes 0700, team group owns only the shared
   folder). The ForceCommand shell must not allow escape to an unrestricted shell for guest users.
   Provide a full, clean teardown.
6. **Do not expose sshd to the public internet.** Connectivity is Tailscale-only (tailnet identity
   replaces passwords/keys).
7. **This is not legal advice baked into code:** anyone shipping this commercially should confirm the
   model with Anthropic. See the disclaimer below.

---

## Commercial-use disclaimer

teamctx is built entirely on public Claude Code configuration surfaces (managed settings, `CLAUDE.md`,
hooks, `.mcp.json`, skills) and standard OS primitives (sshd, Unix users, Tailscale). It never touches
the Claude Code binary or anyone's credentials. Even so, **this is not legal advice.** Anyone deploying
teamctx commercially should confirm the arrangement — in particular the "each human authenticates with
their own consumer plan on a shared host" model — directly with Anthropic before shipping.

---

## Project status

All planned build steps are done, plus the interactive wizard and container isolation. Everything is
tested in **dry-run**; the privileged `--execute` path and container mode's Docker build are
code-complete but **have not been run on a real machine yet**. The single most important open item is
validating `--execute` (both modes) on a throwaway VM. Full detail — what's proven vs. unproven, and
what's left — is in **[STATUS.md](STATUS.md)**.

---

## Repo layout

```
packages/
  server/   MCP context server (Streamable HTTP on 127.0.0.1, SQLite)
  cli/      teamctx provisioner CLI
    src/            host / join / stop / teardown, the wizard, and all artifact renderers
    templates/team/ the /team folder template (CLAUDE.md, .mcp.json, .claude/…)
```

Container-mode artifacts (the Dockerfile, entrypoint, and in-container shell) are **generated** by the
provisioner at run time, not stored as static files.

---

## Development

Requires Node ≥ 20 (the container image uses Node 22).

```bash
npm install         # install workspace deps
npm run build       # compile all packages (do this before typecheck/test — the CLI imports the server)
npm run typecheck   # tsc across workspaces
npm run lint        # eslint + prettier --check
npm test            # vitest — 82 tests
```

CI runs on every push — a matrix of ubuntu-latest + macos-latest (build → lint → typecheck → test), see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Language / stack decision

**Node / TypeScript**, npm workspaces. Rationale:

- Same ecosystem as the official **MCP TypeScript SDK** — the server and CLI share one toolchain, one
  test runner, and one type system.
- `npx` distribution of the CLI for free (once published).
- Only the **hoster** runs the CLI, and the hoster already has Node (it ships with the Claude Code
  ecosystem) — so Go's single-static-binary advantage buys little, while Node keeps us in one language
  with the SDK. Guests never run the CLI; they only `ssh` in.

Boring-technology bias throughout: SQLite over Postgres, launchd/systemd (and Docker's own restart
policy) over custom daemons, shell + sshd over any custom network protocol.
