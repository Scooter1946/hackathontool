# teamctx

**Shared team context for Claude Code.** One teammate hosts; the rest SSH in over
Tailscale. Everyone runs their own unmodified `claude` session under their own Unix
account, authenticated with their own Claude subscription. Every session connects to a
shared **MCP context server** running on the host — a team-wide memory where agents post
findings ("this API is rate-limited"), log decisions ("we switched the schema"), and see
who is working on what.

> Working name. Rename freely.

## Mission

Let a hackathon-style team share **live context across each member's own Claude Code
session**. No established product makes Alice's agent aware of what Bob's agent just
learned, and nothing in this space is "spin up in 10 minutes for a 36-hour hackathon on
someone's laptop." That gap is what teamctx fills.

The product is exactly **two deliverables**:

1. **The MCP context server** — the differentiator. A team-wide memory/coordination
   layer shared across different humans' agents.
2. **A provisioner CLI (`teamctx`)** — one command for the hoster to turn their machine
   into the team server, one command for teammates to join.

We do **not** build an agent runtime, a custom Claude UI, or auth/billing.

## Architecture

```
Hoster's computer (macOS first, Linux second)
├── teamctx CLI (Node/TypeScript)
│   ├── `teamctx host`      → provision everything, print invites
│   ├── `teamctx stop`      → pause hosting (keep data)
│   └── `teamctx teardown`  → remove users, sshd config, settings; keep /team archive
├── MCP context server → localhost HTTP (supervised node process), SQLite storage
├── /team/                        ← shared folder, group-owned
│   ├── CLAUDE.md                 ← team rules: check context before starting, post after
│   ├── .mcp.json                 ← points every session at the localhost MCP server
│   ├── .claude/settings.json     ← SessionStart hook → injects team digest
│   ├── .claude/hooks/…           ← hook scripts
│   └── repo/ (shared clone) + worktrees/<user>/ ← each teammate on their own branch
├── /etc/claude-code/managed-settings.json  ← fixed folders + deny rules, machine-wide
├── sshd: Match Group teamctx → ForceCommand launch script (cd to your worktree, exec claude)
└── Tailscale: `tailscale up --ssh`, ACL: tailnet members → ssh as their unix user

Teammates: click invite link (join tailnet) → click ssh:// link → land inside Claude Code
```

## Quickstart

> `teamctx host` mutates the machine (creates users, edits sshd, writes system settings). It runs a
> **safe dry-run by default** — rendering every file and printing every privileged command without
> applying anything. Add `--execute` (as root) only on a host you mean to provision, ideally a VM.

### Hoster

The fastest start is the **interactive wizard** — run `teamctx host` with no flags. It checks your
tools (preflight), asks for the repo and teammate usernames, renders the full dry-run for you to
review, and then prints the exact `sudo … --execute` command to apply (or applies it directly if
you're already root):

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

`host` starts the MCP context server (supervised), clones your repo into `/team/repo`, stamps
`/team`, creates locked-down guest accounts, writes machine-wide managed settings that pre-approve
the context server, restricts the `teamctx` SSH group to Claude Code via `ForceCommand`, brings up
Tailscale, and prints a per-teammate invite (tailnet step + `ssh://` link + QR code). Each teammate
is auto-allocated their own branch (`teamctx/<user>`) and git worktree on first connect, so they
work independently and share by pushing/PR-ing.

Pause or remove hosting:

```bash
teamctx stop --execute                          # disable guest SSH + stop the server; keep all data
teamctx teardown --users alice,bob --execute    # remove everything; archive /team to a tarball
```

### Teammate

You only need the invite. Join the tailnet, then click the `ssh://` link or run:

```bash
teamctx join ssh://alice@<host-magicdns-name>
```

You land directly in your own Claude Code session, on your own branch's worktree. On first connect Claude asks
you to log in with **your own** Claude account (a URL + paste-back code) — teamctx never sees your
credentials.

The first connect also runs a one-time `gh auth login` so your commits and pushes are attributed to
your own GitHub account (same paste-a-code flow; teamctx never holds the token) — you work on your own
branch `teamctx/<you>` and share by pushing or opening a PR.

From there the shared tools (`get_context`, `post_finding`, `claim_task`, …) and the
auto-injected team digest just work.

**Claude desktop app (optional):** instead of the terminal, add the host as an SSH connection in the
app's environment dropdown for one-click reconnects. Claude Code executes on the host, so the same
managed settings and isolation apply.

## HARD CONSTRAINTS — NOT ALLOWED (legal / ToS)

Violating any of these invalidates the project. When in doubt, choose the design that
keeps us further from these lines.

1. **NEVER** modify, fork, re-skin, wrap, patch, or inject into the Claude Code binary or
   its UI. Claude Code is proprietary (Anthropic Commercial ToS, not open source). All
   customization must be pure configuration: managed settings, CLAUDE.md, hooks,
   `.mcp.json`, skills, shell/sshd config.
2. **NEVER** touch users' Claude credentials. Do not collect, store, copy, proxy, forward,
   read, or programmatically use anyone's OAuth token, `~/.claude` contents, or session
   credentials. Consumer (Free/Pro/Max) OAuth tokens may not be used "in any other
   product, tool, or service" — our product must stay entirely out of the auth path. Each
   human runs `claude` themselves and logs in themselves.
3. **NEVER** programmatically drive Claude Code sessions on users' behalf (no headless
   `-p` invocations, no Agent SDK calls, no expect/pty scripting of the `claude` binary)
   using consumer accounts. If a server-side agent feature is ever wanted, it requires an
   API key the hoster pays for — out of scope for v1.
4. **NEVER** auto-complete the user's Claude login. The first-run OAuth (URL + paste-code,
   ~30s) must be performed by the human. We may print instructions; we may not automate
   it.
5. **No malicious or invasive capability on the host machine.** Guest accounts get no
   sudo, no access outside the team folder (Unix permissions: guest homes 0700, team group
   owns only the shared folder). The ForceCommand shell must not allow escape to an
   unrestricted shell for guest users. Provide a full, clean teardown.
6. **Do not expose sshd to the public internet.** Connectivity is Tailscale-only (tailnet
   identity replaces passwords/keys).
7. **This is not legal advice baked into code:** anyone shipping this commercially should
   confirm the model with Anthropic. See the disclaimer below.

## Commercial-use disclaimer

teamctx is built entirely on public Claude Code configuration surfaces (managed settings,
`CLAUDE.md`, hooks, `.mcp.json`, skills) and standard OS primitives (sshd, Unix users,
Tailscale). It never touches the Claude Code binary or anyone's credentials. Even so,
**this is not legal advice.** Anyone deploying teamctx commercially should confirm the
arrangement — in particular the "each human authenticates with their own consumer plan on
a shared host" model — directly with Anthropic before shipping.

## Build plan

| Step | Deliverable                          |
| ---- | ------------------------------------ |
| 0    | Scaffold + decisions (this repo)     |
| 1    | MCP context server (product core)    |
| 2    | Team folder template                 |
| 3    | `teamctx host` provisioner           |
| 4    | `teamctx join` / `stop` / `teardown` |
| 5    | Multi-user integration test          |
| 6    | Polish and docs                      |

## Repo layout

```
packages/
  server/   MCP context server (Streamable HTTP on 127.0.0.1, SQLite)
  cli/      teamctx provisioner CLI
```

## Development

Requires Node ≥ 20.

```bash
npm install         # install workspace deps
npm run typecheck   # tsc across workspaces
npm run lint        # eslint + prettier --check
npm test            # vitest
npm run build       # compile all packages
```

## Security & verification

teamctx's isolation is standard OS hardening — separate non-admin Unix users, `0700` homes, an sshd
`ForceCommand` that drops guests straight into Claude Code with no shell and no forwarding, and
machine-wide managed settings. Read **[SECURITY.md](SECURITY.md)** for the model and, importantly,
what it does **not** protect against (a hostile teammate is still a process on your machine).
**[VERIFICATION.md](VERIFICATION.md)** lists what CI checks automatically and the manual VM checklist
for the privileged `--execute` path.

## Language / stack decision (Step 0)

**Node / TypeScript**, npm workspaces. Rationale:

- Same ecosystem as the official **MCP TypeScript SDK** — the server and CLI share one
  toolchain, one test runner, and one type system.
- `npx` distribution of the CLI for free.
- Only the **hoster** runs the CLI, and the hoster already has Node (it ships with the
  Claude Code ecosystem) — so Go's single-static-binary advantage buys us little, while
  Node keeps us in one language with the SDK. Guests never run the CLI; they only `ssh` in.

Boring-technology bias throughout: SQLite over Postgres, launchd/systemd over custom
daemons, shell + sshd over any custom network protocol.
