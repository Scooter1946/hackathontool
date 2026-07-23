/**
 * Pure renderers for the *container* isolation mode (`teamctx host --isolation container`).
 *
 * In this mode a teammate's Claude Code session runs inside a single long-lived Linux container
 * ("the box") instead of directly on the host. The container mounts only the folders the host
 * explicitly exposes (always `/team`, plus any `--expose` paths), so from inside, `ls /` shows only
 * the container's own root — the host user's files simply do not exist in that filesystem view.
 * This turns the soft "agent, please stay in /team" guardrail into a hard OS boundary.
 *
 * Flow:  ssh → host sshd (ForceCommand) → host bridge → `sudo -n teamctx-enter`
 *        → `docker exec -u <user>` into the box → the in-container ForceCommand shell → `exec claude`.
 *
 * Hard Constraint #1 compliance: Claude Code is installed *unmodified* from Anthropic's official
 * signed apt repository and merely confined by the container. We never patch, wrap, or inject into
 * the binary — confinement via containers/namespaces is OS configuration, the same category as the
 * sshd ForceCommand and managed settings we already use.
 *
 * Everything here is a pure function returning bytes/argv. Nothing performs I/O or runs Docker; the
 * dry-run prints these for review and the tests assert them, exactly like host-artifacts.ts.
 */

/** Isolation mode for `teamctx host`. "host" runs Claude directly on the machine; "container" jails it. */
export type Isolation = "host" | "container";

export const CONTAINER_DEFAULTS = {
  image: "teamctx-box:local",
  containerName: "teamctx-box",
  /** Host directory holding each teammate's private (0700) home — deliberately outside /team. */
  homesDir: "/var/lib/teamctx/homes",
  /** Root-owned host script the guest may run via a scoped sudoers rule. */
  enterPath: "/usr/local/bin/teamctx-enter",
  /** The ForceCommand target on the host: a thin bridge that execs `sudo -n teamctx-enter`. */
  bridgePath: "/usr/local/bin/teamctx-shell",
  /** The ForceCommand shell *inside* the container (reuses host-artifacts' renderTeamctxShell). */
  containerShellPath: "/usr/local/bin/teamctx-shell",
} as const;

/** A host path exposed into the box. `readOnly` maps to a `:ro` bind mount. */
export interface Expose {
  host: string;
  container: string;
  readOnly: boolean;
}

export interface ContainerOptions {
  image: string;
  containerName: string;
  port: number;
  group: string;
  teamDir: string;
  homesDir: string;
  /** Extra host paths to expose beyond /team (which is always mounted). */
  exposes: Expose[];
  users: string[];
  enterPath: string;
  bridgePath: string;
  containerShellPath: string;
}

/**
 * Parse an `--expose` value: `/path` (rw, same path in box), `/host:/box` (remap), or either with a
 * trailing `:ro` for read-only. The container path defaults to the host path when not remapped.
 */
export function parseExpose(spec: string): Expose {
  let readOnly = false;
  let body = spec;
  if (body.endsWith(":ro")) {
    readOnly = true;
    body = body.slice(0, -3);
  } else if (body.endsWith(":rw")) {
    body = body.slice(0, -3);
  }
  const colon = body.indexOf(":");
  const host = colon === -1 ? body : body.slice(0, colon);
  const container = colon === -1 ? body : body.slice(colon + 1);
  if (!host || !container) throw new Error(`invalid --expose value: ${spec}`);
  return { host, container, readOnly };
}

/** `docker run` bind-mount args for the exposed paths. */
export function renderExposeMounts(exposes: Expose[]): string[] {
  const args: string[] = [];
  for (const e of exposes) {
    args.push("-v", `${e.host}:${e.container}${e.readOnly ? ":ro" : ""}`);
  }
  return args;
}

/**
 * The image. Two stages: a builder that compiles the context server (better-sqlite3 is a native
 * module and must be built for the container's Linux/arch, never copied from macOS), and a slim
 * runtime that installs git, the GitHub CLI, and Claude Code from Anthropic's official signed apt
 * repo. Auto-update is left off (apt installs don't self-update) for a reproducible box.
 */
export function renderContainerfile(o: ContainerOptions): string {
  return [
    "# syntax=docker/dockerfile:1",
    "# teamctx box — an unmodified Claude Code install, confined by the container (Hard Constraint #1).",
    "",
    "FROM node:22-bookworm AS builder",
    "WORKDIR /src",
    "# Build tools for better-sqlite3's native addon.",
    "RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \\",
    "    && rm -rf /var/lib/apt/lists/*",
    "# Bring in the monorepo and build the server (compiles better-sqlite3 for this platform).",
    "COPY package*.json ./",
    "COPY packages/server packages/server",
    "RUN npm ci --workspace @teamctx/server --omit=dev \\",
    "    && npm run build --workspace @teamctx/server",
    "",
    "FROM node:22-bookworm-slim AS runtime",
    "ENV DEBIAN_FRONTEND=noninteractive",
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "    ca-certificates curl gnupg git ripgrep sudo \\",
    "    && rm -rf /var/lib/apt/lists/*",
    "# GitHub CLI — official apt repo (teammates authenticate as themselves via `gh auth login`).",
    "RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\",
    "      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \\",
    '    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\',
    "      > /etc/apt/sources.list.d/github-cli.list \\",
    "    && apt-get update && apt-get install -y --no-install-recommends gh \\",
    "    && rm -rf /var/lib/apt/lists/*",
    "# Claude Code — Anthropic's official signed apt repo. Unmodified; we only confine it.",
    "RUN install -d -m 0755 /etc/apt/keyrings \\",
    "    && curl -fsSL https://downloads.claude.ai/keys/claude-code.asc \\",
    "      -o /etc/apt/keyrings/claude-code.asc \\",
    '    && echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" \\',
    "      > /etc/apt/sources.list.d/claude-code.list \\",
    "    && apt-get update && apt-get install -y --no-install-recommends claude-code \\",
    "    && rm -rf /var/lib/apt/lists/*",
    `RUN groupadd -f ${o.group}`,
    "# Machine-wide managed settings baked into the box: grant /team, deny sudo, pre-approve the MCP",
    "# server (so the in-box session connects with no trust prompt). Provisioner generates the JSON.",
    "COPY managed-settings.json /etc/claude-code/managed-settings.json",
    "COPY --from=builder /src/packages/server/dist /opt/teamctx/server/dist",
    "COPY --from=builder /src/packages/server/node_modules /opt/teamctx/server/node_modules",
    "# entrypoint.sh and teamctx-shell are generated by the provisioner into the build context",
    "# (renderContainerEntrypoint / renderTeamctxShell) — not static files in the source tree.",
    "COPY entrypoint.sh /usr/local/bin/teamctx-entrypoint",
    `COPY teamctx-shell ${o.containerShellPath}`,
    `RUN chmod 0755 /usr/local/bin/teamctx-entrypoint ${o.containerShellPath}`,
    `ENV TEAMCTX_PORT=${o.port} TEAMCTX_DATA_DIR=${o.teamDir}/.teamctx-data`,
    'ENTRYPOINT ["/usr/local/bin/teamctx-entrypoint"]',
    "",
  ].join("\n");
}

/**
 * Container entrypoint (PID 1). Ensures the teamctx group and each teammate's account + private
 * 0700 home exist, then starts the context server in the foreground. Guests never run this — they
 * are `docker exec`'d in afterward by teamctx-enter.
 * Written as a plain string so bash ${vars} stay literal.
 */
export function renderContainerEntrypoint(o: ContainerOptions): string {
  return [
    "#!/bin/bash",
    "# teamctx box entrypoint — provision teammate accounts, then run the context server.",
    "set -euo pipefail",
    "",
    `GROUP="${o.group}"`,
    'getent group "${GROUP}" >/dev/null || groupadd "${GROUP}"',
    "",
    "# TEAMCTX_USERS is a comma-separated list injected at `docker run` time.",
    'IFS="," read -ra USERS <<< "${TEAMCTX_USERS:-}"',
    'for U in "${USERS[@]}"; do',
    '  [ -z "${U}" ] && continue',
    '  if ! id -u "${U}" >/dev/null 2>&1; then',
    '    useradd -m -s /bin/bash -g "${GROUP}" "${U}"',
    "  fi",
    "  # Private home: only the teammate can read it, so their Claude/gh tokens stay isolated.",
    '  chmod 700 "/home/${U}" 2>/dev/null || true',
    '  chown "${U}:${GROUP}" "/home/${U}" 2>/dev/null || true',
    "done",
    "",
    "# Run the context server on loopback *inside* the box; docker-exec'd sessions share this",
    "# network namespace, so /team/.mcp.json's 127.0.0.1 target keeps working unchanged.",
    "exec node /opt/teamctx/server/dist/main.js",
    "",
  ].join("\n");
}

/**
 * `docker run` argv (after the literal `docker`). Creates the long-lived box. Security posture:
 * only /team and the private homes dir (plus explicit exposes) are mounted; the Docker socket is
 * never mounted; capabilities are dropped and privilege escalation disabled; nothing is published
 * to a public port (sessions reach the server via docker exec, sharing the net namespace).
 */
export function renderContainerCreateArgs(o: ContainerOptions): string[] {
  return [
    "run",
    "-d",
    "--name",
    o.containerName,
    "--restart",
    "unless-stopped",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    `TEAMCTX_PORT=${o.port}`,
    "-e",
    `TEAMCTX_USERS=${o.users.join(",")}`,
    "-e",
    `TEAMCTX_DATA_DIR=${o.teamDir}/.teamctx-data`,
    "-v",
    `${o.teamDir}:${o.teamDir}`,
    "-v",
    `${o.homesDir}:/home`,
    ...renderExposeMounts(o.exposes),
    o.image,
  ];
}

/**
 * Host ForceCommand target. Deliberately trivial: it hands off to the root-owned enter script via a
 * scoped sudo rule. The guest's own account has no Docker access at all.
 */
export function renderHostBridge(o: ContainerOptions): string {
  return [
    "#!/bin/bash",
    "# teamctx host bridge — the sshd ForceCommand for the teamctx group in container mode.",
    "# Guests can run exactly one privileged thing (via a pinned sudoers rule): teamctx-enter.",
    "set -euo pipefail",
    `exec sudo -n ${o.enterPath}`,
    "",
  ].join("\n");
}

/**
 * Root-owned enter script (run only via the pinned sudoers rule). Identity comes from `$SUDO_USER`
 * — the authenticated SSH user — never from arguments, so a teammate cannot enter as someone else.
 * It execs into the box as that user and launches the in-container ForceCommand shell.
 */
export function renderEnterScript(o: ContainerOptions): string {
  return [
    "#!/bin/bash",
    "# teamctx-enter — root-owned; invoked only via the scoped sudoers rule from the host bridge.",
    "set -euo pipefail",
    "",
    'U="${SUDO_USER:-}"',
    'if [ -z "${U}" ]; then echo "teamctx: no SUDO_USER" >&2; exit 1; fi',
    "# Allow only names that were provisioned as box users (defense-in-depth on the identity).",
    `case ",${o.users.join(",")}," in`,
    '  *",${U},"*) : ;;',
    '  *) echo "teamctx: ${U} is not a teamctx user" >&2; exit 1 ;;',
    "esac",
    "",
    `exec docker exec -it -u "\${U}" ${o.containerName} ${o.containerShellPath}`,
    "",
  ].join("\n");
}

/** Scoped sudoers rule: the teamctx group may run *only* the enter script, without a password. */
export function renderSudoersEntry(o: ContainerOptions): string {
  return `%${o.group} ALL=(root) NOPASSWD: ${o.enterPath}\n`;
}
