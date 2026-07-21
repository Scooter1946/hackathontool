# Security model

teamctx lets several people's Claude Code sessions share one host. Its isolation is built entirely
from standard OS primitives and Claude Code's own configuration surfaces — it never modifies Claude
Code and never touches anyone's credentials.

## What isolates guests

- **Separate Unix users, no admin.** Each teammate is a distinct non-admin account; managed settings
  additionally deny `sudo`/`su`.
- **`0700` home directories.** Guests cannot read each other's or the hoster's home (OS permissions).
- **Shared work only in `/team`.** The `teamctx` group owns `/team` (setgid); Claude Code's managed
  `additionalDirectories` grants access to `/team` (which holds each teammate's worktree) — and nothing else.
- **`ForceCommand` shell.** The `teamctx` SSH group is pinned to `/usr/local/bin/teamctx-shell`, which
  `exec`s Claude Code in the teammate's own worktree and ignores any command the client requested — no
  interactive shell, no arbitrary commands. TCP / agent / X11 forwarding and tunnels are disabled.
- **Tailscale-only.** sshd is never exposed to the public internet; tailnet identity replaces
  passwords and keys.
- **Own-account auth.** Everyone logs in with their own Claude plan; the server only ever sees an
  `X-Teamctx-User` label derived from the Unix username, never a credential.

## What it does NOT protect against

Be honest with your team about the threat model:

- **A hostile teammate is still on your machine.** Anyone you invite runs code (through their agent)
  on your hardware. Guest accounts are unprivileged and scoped to `/team`, but this is **not** a
  container or VM boundary. Don't invite anyone you wouldn't hand a normal SSH account.
- **Shared `/team` is shared.** Everyone in the group can read and write everything under `/team`,
  including the SQLite context database. There is no per-user secrecy within the team.
- **The context server is unauthenticated on loopback.** Identity is a self-declared header; any local
  process on the host could post as any user. The real boundary is the OS user separation, not the
  header.
- **OS/sshd local-privilege-escalation bugs are out of scope.** Keep the host patched.
- **`--execute` is powerful.** The provisioner edits `sshd_config`, creates users, and writes
  system-wide managed settings. Validate on a throwaway VM (see [VERIFICATION.md](VERIFICATION.md))
  before running it anywhere you care about. `teamctx teardown` reverses it and archives `/team`.

## Commercial use

See the disclaimer in the [README](README.md#commercial-use-disclaimer): teamctx stays out of the
credential path and off the Claude Code binary, but anyone shipping this commercially should confirm
the model — especially "each human uses their own consumer plan on a shared host" — with Anthropic.
