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
│   └── repo/ + worktrees/<user>/ ← per-user git worktrees to avoid file conflicts
├── /etc/claude-code/managed-settings.json  ← fixed folders + deny rules, machine-wide
├── sshd: Match Group teamctx → ForceCommand launch script (cd worktree, exec claude)
└── Tailscale: `tailscale up --ssh`, ACL: tailnet members → ssh as their unix user

Teammates: click invite link (join tailnet) → click ssh:// link → land inside Claude Code
```

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
