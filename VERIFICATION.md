# Verification

## Automated (runs in CI on macOS + Linux)

`npm test` exercises:

- **Storage** — findings, decisions, the task board, and the digest (`packages/server/src/db.test.ts`).
- **MCP server, two users** — alice posts a finding over the real Streamable-HTTP transport; bob's
  `get_context` sees it, attributed to alice; the task board is shared (`packages/server/src/server.test.ts`).
- **SessionStart hook** — the actual hook script fetches the live `/digest`, and degrades gracefully
  when the server is down (`packages/cli/src/template.test.ts`).
- **Full shared-context loop** — A posts via MCP → B's SessionStart hook digest shows it → B reads the
  detail via `get_context` (`packages/cli/src/integration.test.ts`).
- **Provisioner** — every artifact renderer, `host --dry-run` rendering the full tree under a prefix,
  and `teardown` reversing `host` (`packages/cli/src/host.test.ts`, `lifecycle.test.ts`).

CI runs on every push — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Manual (requires `teamctx host --execute` on a clean VM)

The privileged provisioning path is **gated** (`--execute`, root) and must be validated on a
**throwaway VM** — never a machine you care about. After `sudo teamctx host --users alice,bob --execute`:

1. **Shared context over real SSH.** SSH in as `alice`, post a finding in Claude Code; SSH in as `bob`
   and confirm the SessionStart digest already shows it and `get_context` returns the detail.
2. **Deny rules.** Create a canary file in the hoster's home. From a guest session, confirm the agent
   cannot read it — only `/team` (the shared working tree) is permitted (managed `additionalDirectories`).
3. **ForceCommand escape.** `ssh alice@host /bin/bash` must **not** yield a shell — it lands in Claude
   Code. Port forwarding (`ssh -L …`) must be refused (`AllowTcpForwarding no`).
4. **Home isolation.** Guest homes are `0700`; a guest cannot read another guest's or the hoster's home
   (enforced by OS permissions, independent of Claude Code).
5. **Teardown restores the machine.** `sudo teamctx teardown --users alice,bob --execute`, then diff
   `/etc/ssh/sshd_config` against a pre-`host` backup: the teamctx block is gone, no teamctx users/group
   remain, and `/team` has been archived to a tarball.

A two-Unix-user Linux container (sshd + two accounts, running `--execute`) is the recommended
automated form of the above. It runs the gated privileged path, so it belongs on CI infrastructure
you control, not in the dry-run test suite.
