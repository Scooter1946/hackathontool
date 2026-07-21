/**
 * Pure renderers for everything `teamctx host` would install. Each function returns the exact
 * bytes/commands a real run would use, so the dry-run can show (and tests can assert) them without
 * touching the machine. Nothing here performs I/O or privileged actions.
 */

export type Platform = "darwin" | "linux";

export const DEFAULTS = {
  teamDir: "/team",
  port: 4517,
  group: "teamctx",
  shellPath: "/usr/local/bin/teamctx-shell",
  serverLabel: "com.teamctx.context-server",
} as const;

/** Verified against code.claude.com: highest-precedence managed policy file, per platform. */
export const MANAGED_SETTINGS_PATH: Record<Platform, string> = {
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
};

export interface ArtifactOptions {
  teamDir: string;
  port: number;
  group: string;
  shellPath: string;
  users: string[];
  platform: Platform;
  magicDnsName: string;
  nodePath: string;
  serverEntry: string;
  dataDir: string;
  home: string;
}

export interface Command {
  argv: string[];
  sudo: boolean;
  description: string;
}

/**
 * Managed settings: grant access to the shared /team folder, deny privilege escalation, and
 * pre-approve the teamctx MCP server. The pre-approval is the key to zero-manual-connection —
 * managed-settings approvals apply even in an untrusted folder, unlike project .mcp.json alone.
 */
export function renderManagedSettings(o: ArtifactOptions): Record<string, unknown> {
  return {
    permissions: {
      additionalDirectories: [o.teamDir],
      deny: ["Bash(sudo)", "Bash(sudo *)", "Bash(su)", "Bash(su *)"],
    },
    enabledMcpjsonServers: ["teamctx"],
  };
}

// Shell-safe sentinels (no quotes/parens): they are embedded in grep/awk commands.
export const SSHD_BEGIN = "# >>> teamctx managed block - teamctx teardown removes this >>>";
export const SSHD_END = "# <<< teamctx managed block <<<";

/** sshd Match block: restrict the teamctx group to the ForceCommand shell, no forwarding/tunnels. */
export function renderSshdMatchBlock(o: ArtifactOptions): string {
  return [
    SSHD_BEGIN,
    `Match Group ${o.group}`,
    `    ForceCommand ${o.shellPath}`,
    "    AllowTcpForwarding no",
    "    AllowStreamLocalForwarding no",
    "    AllowAgentForwarding no",
    "    X11Forwarding no",
    "    PermitTunnel no",
    "    PermitTTY yes",
    SSHD_END,
    "",
  ].join("\n");
}

/**
 * The ForceCommand shell. Guests never reach an interactive prompt: it exec()s Claude Code in the
 * shared working tree and ignores whatever command the SSH client requested, so there is no escape.
 * Lines containing bash ${vars} are plain JS strings (not template literals) to keep them literal.
 */
export function renderTeamctxShell(o: ArtifactOptions): string {
  return [
    "#!/bin/bash",
    "# teamctx ForceCommand shell — set as ForceCommand for the teamctx group in sshd_config.",
    "# Guests never get an interactive shell: this exec()s Claude Code in the shared tree and",
    "# ignores any command the SSH client requested, so there is no shell escape.",
    "set -euo pipefail",
    "",
    'USER_NAME="$(id -un)"',
    `TEAM_DIR="${o.teamDir}"`,
    "# Everyone shares one working tree — same files, same time (no per-user isolation).",
    'WORKDIR="${TEAM_DIR}/repo"',
    "",
    'export TEAMCTX_USER="${USER_NAME}"',
    `export TEAMCTX_PORT="${o.port}"`,
    "",
    'if [ ! -d "${WORKDIR}" ]; then',
    '  WORKDIR="${TEAM_DIR}"',
    "fi",
    'cd "${WORKDIR}"',
    "",
    'FLAG="${HOME}/.teamctx-welcomed"',
    'if [ ! -f "${FLAG}" ]; then',
    "  cat <<'WELCOME'",
    "────────────────────────────────────────────────────────────",
    " Welcome to the teamctx shared workspace.",
    " Claude Code will start now. On first run it asks you to log in",
    " with YOUR OWN Claude account (a URL + paste-back code).",
    " teamctx never sees or handles your credentials.",
    "────────────────────────────────────────────────────────────",
    "WELCOME",
    '  touch "${FLAG}" 2>/dev/null || true',
    "fi",
    "",
    "exec claude",
    "",
  ].join("\n");
}

/** macOS launchd LaunchAgent that supervises the context server (runs as the hoster, on loopback). */
export function renderLaunchdPlist(o: ArtifactOptions): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${DEFAULTS.serverLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${o.nodePath}</string>`,
    `    <string>${o.serverEntry}</string>`,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>TEAMCTX_PORT</key>",
    `    <string>${o.port}</string>`,
    "    <key>TEAMCTX_DATA_DIR</key>",
    `    <string>${o.dataDir}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${o.dataDir}/server.log</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${o.dataDir}/server.err.log</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Linux systemd user unit that supervises the context server. */
export function renderSystemdUnit(o: ArtifactOptions): string {
  return [
    "[Unit]",
    "Description=teamctx context server",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart=${o.nodePath} ${o.serverEntry}`,
    `Environment=TEAMCTX_PORT=${o.port}`,
    `Environment=TEAMCTX_DATA_DIR=${o.dataDir}`,
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Per-teammate invite blurb. The one-time login note honors Hard Constraint 4 (we never automate it). */
export function renderInvite(o: ArtifactOptions, user: string): string {
  return [
    `Teammate: ${user}`,
    "  1. Join the tailnet (accept the host's invite link, or run: tailscale up)",
    `  2. Connect:  ssh://${user}@${o.magicDnsName}`,
    "  3. On first connect, Claude Code asks you to log in with YOUR OWN Claude",
    "     account (URL + paste-back code). teamctx never sees your credentials.",
  ].join("\n");
}

/** Illustrative Tailscale SSH ACL snippet for the hoster to paste into their tailnet admin. */
export function renderAclSnippet(o: ArtifactOptions): string {
  const users = o.users.map((u) => `        "${u}@"`).join(",\n");
  return [
    "// Paste into your tailnet SSH ACLs at https://login.tailscale.com/admin/acls",
    "{",
    '  "ssh": [',
    "    {",
    '      "action": "accept",',
    '      "src": ["autogroup:member"],',
    `      "dst": ["${o.magicDnsName}"],`,
    '      "users": [',
    users,
    "      ]",
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

/** Command to create the teamctx group (idempotent flags where the platform supports them). */
export function groupCommands(o: ArtifactOptions): Command[] {
  if (o.platform === "darwin") {
    return [
      {
        argv: ["dseditgroup", "-o", "create", o.group],
        sudo: true,
        description: `create group ${o.group}`,
      },
    ];
  }
  return [
    { argv: ["groupadd", "-f", o.group], sudo: true, description: `create group ${o.group}` },
  ];
}

/**
 * Commands to create a single guest user with no admin rights and a 0700 home. The login shell is a
 * real shell (ForceCommand runs via it), but sshd's ForceCommand + the teamctx shell mean the guest
 * only ever lands in Claude Code.
 */
export function userCommands(o: ArtifactOptions, user: string): Command[] {
  if (o.platform === "darwin") {
    return [
      {
        argv: [
          "sysadminctl",
          "-addUser",
          user,
          "-fullName",
          user,
          "-shell",
          "/bin/bash",
          "-home",
          `/Users/${user}`,
        ],
        sudo: true,
        description: `create user ${user} (no admin)`,
      },
      {
        argv: ["dseditgroup", "-o", "edit", "-a", user, "-t", "user", o.group],
        sudo: true,
        description: `add ${user} to ${o.group}`,
      },
      {
        argv: ["chmod", "700", `/Users/${user}`],
        sudo: true,
        description: `lock ${user} home to 0700`,
      },
    ];
  }
  return [
    {
      argv: ["useradd", "-m", "-G", o.group, "-s", "/bin/bash", user],
      sudo: true,
      description: `create user ${user}`,
    },
    {
      argv: ["chmod", "700", `/home/${user}`],
      sudo: true,
      description: `lock ${user} home to 0700`,
    },
  ];
}

/** Commands to group-own /team with setgid so guests share it but can't reach each other's homes. */
export function teamDirCommands(o: ArtifactOptions): Command[] {
  return [
    {
      argv: ["chgrp", "-R", o.group, o.teamDir],
      sudo: true,
      description: `group-own ${o.teamDir}`,
    },
    {
      argv: ["chmod", "-R", "2775", o.teamDir],
      sudo: true,
      description: `setgid + group-write ${o.teamDir}`,
    },
  ];
}
