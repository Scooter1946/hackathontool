# Project status

_Snapshot: 2026-07-23 · main (interactive wizard + container isolation, dry-run)_

## Stage in one line

All 6 planned build steps are **done**, plus three enhancements (per-user branches, per-user
GitHub auth, an interactive host wizard). Everything works and is tested in **dry-run / dev**. The
privileged provisioning path (`--execute`) has **never been run on a real machine** — that
validation, and publishing for distribution, are the main things left.

**Confidence:** the pure logic and rendered artifacts are CI-verified on macOS + Linux (54 tests).
The machine-mutating path is code-complete but **unproven** — treat it as untested until the VM
checklist in [VERIFICATION.md](VERIFICATION.md) has been run.

## What's done ✅

**The two deliverables (build plan Steps 0–6):**

- **MCP context server** — Streamable-HTTP on `127.0.0.1`, SQLite storage, 7 tools:
  `get_context`, `post_finding`, `log_decision`, `claim_task`, `release_task`, `list_tasks`,
  `get_digest`. Identity via an `X-Teamctx-User` header.
- **Team folder template** — `CLAUDE.md`, `.mcp.json` (points sessions at the local server),
  and a `SessionStart` hook that injects the live team digest into every session.
- **Provisioner CLI (`teamctx`)** — `host` / `join` / `stop` / `teardown`. Dry-run by default;
  `--execute` is gated behind an explicit flag **and** root.

**Enhancements since the plan:**

- **Per-user git branches** — each teammate is auto-allocated `teamctx/<user>` + a worktree off the
  shared `/team/repo` on first connect.
- **Per-user GitHub auth (Model A)** — one-time `gh auth login` on first connect so commits/pushes
  are attributed to each person's own account; teamctx never holds a token.
- **Interactive host wizard** — `teamctx host` (no flags) walks through preflight → repo/usernames →
  dry-run review → offer to apply. Applies for real only if the user confirms _and_ is already root;
  otherwise it prints the exact `sudo … --execute` command.
- **Container isolation** (`--isolation container`) — an optional hard OS jail: teammates' sessions
  run inside one Linux "box" container that mounts only `/team` + private per-user homes (+ any
  `--expose`), so `ls /` shows nothing of the host. Claude Code is installed unmodified from
  Anthropic's official signed apt repo; a scoped-sudo bridge (`$SUDO_USER`, no host Docker access)
  connects sessions. Renderers + full provisioner/teardown wiring landed; **dry-run only so far**.

**Quality gates:**

- **82 tests** across 11 files (Vitest), including a full two-user shared-context loop.
- **CI** on every push — matrix ubuntu-latest + macOS-latest (build → lint → typecheck → test).
- Typecheck + ESLint (flat config) + Prettier all clean.
- Docs: [README.md](README.md) (mission, hard constraints, quickstart), [SECURITY.md](SECURITY.md)
  (isolation model + what it does _not_ protect against), [VERIFICATION.md](VERIFICATION.md).

## What's proven vs. unproven

| Area                                              | Status                                          |
| ------------------------------------------------- | ----------------------------------------------- |
| Server, storage, digest, hook, template           | ✅ Proven in CI                                 |
| CLI parsing, plan building, dry-run rendering     | ✅ Proven in CI                                 |
| Wizard flow                                       | ✅ Unit-tested + one live dry-run smoke run     |
| `--execute` (creates users, edits sshd, settings) | ⚠️ Code + dry-run only — **never run for real** |
| Multi-user over real SSH + Tailscale              | ⚠️ Never exercised end-to-end                   |
| Container isolation (`--isolation container`)     | ⚠️ Renderers + wiring tested; image never built |

## What's left ⏳

1. **Validate `--execute` on a throwaway VM.** The single most important open item. Run the manual
   checklist in [VERIFICATION.md](VERIFICATION.md): shared context over real SSH, per-user branch +
   `gh` identity, deny-rule canary, `ForceCommand` escape attempt, home isolation, and a clean
   teardown diff. Ideally automate it as a two-user Linux container on CI infra you control.
   **Container mode** additionally needs Docker/OrbStack and one end-to-end build of the box image
   validated (`ls /` shows only `/team`, per-user tokens isolated, `teardown` removes box + image).
2. **Publish for distribution (Tier 2a, ~half day).** Packages are `private: true` and unpublished,
   so `npx teamctx …` does **not** work for anyone outside this cloned repo yet. Flip `private`,
   bundle CLI + server into one artifact, `npm publish`. Until then, distribution = clone + build.
3. **Multi-agent communication policy.** Deliberately deferred — the framework is in place
   (shared context + task board); the coordination _policy_ on top of it is still to be designed.
4. **Confirm the commercial model with Anthropic.** Currently a disclaimer only (README). The
   "each human uses their own consumer plan on a shared host" arrangement should be confirmed before
   any commercial use.
5. **(Optional) Desktop GUI (Tier 3).** Evaluated and **deferred** — weeks of work + a $99/yr Apple
   signing account, low ROI for a technical hackathon audience vs. the CLI wizard.

## Run it right now

```bash
npm install
npm run build
npm test                 # 82 tests
teamctx host             # interactive wizard (safe dry-run; prints the apply command)
```

> The dry-run renders every file and prints every privileged command it _would_ run, changing
> nothing. Only `--execute` as root mutates the machine — and only after VM validation.

## Constraints still in force

The seven **HARD CONSTRAINTS** in [README.md](README.md#hard-constraints--not-allowed-legal--tos)
remain binding — never wrap/modify the Claude Code binary, never touch anyone's Claude credentials,
never drive sessions programmatically with consumer accounts, Tailscale-only, clean teardown. When
in doubt, choose the design that stays further from those lines.
