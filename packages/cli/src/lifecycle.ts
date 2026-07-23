import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import * as C from "./container-artifacts.js";
import * as A from "./host-artifacts.js";
import { defaultLog, executePlanItems, type PlanItem, writePlanDryRun } from "./plan.js";

/** Options shared by `stop`, `teardown`, and `join`. Not every field is used by every command. */
export interface LifecycleOptions {
  users: string[];
  teamDir: string;
  platform: A.Platform;
  dryRun: boolean;
  prefix: string;
  sshUrl?: string;
  archivePath?: string;
  /** Must match how the host was provisioned so stop/teardown reverse the right artifacts. */
  isolation: C.Isolation;
}

export interface LifecycleResult {
  dryRun: boolean;
  written: string[];
}

export function parseLifecycleArgs(argv: string[]): LifecycleOptions {
  let users: string[] = [];
  let teamDir: string = A.DEFAULTS.teamDir;
  let dryRun = true;
  let prefix = "";
  let sshUrl: string | undefined;
  let archivePath: string | undefined;
  let isolation: C.Isolation = "host";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--users":
        users = (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--team-dir":
        teamDir = argv[++i] ?? teamDir;
        break;
      case "--prefix":
        prefix = argv[++i] ?? "";
        break;
      case "--ssh":
        sshUrl = argv[++i];
        break;
      case "--archive":
        archivePath = argv[++i];
        break;
      case "--isolation": {
        const value = argv[++i];
        if (value !== "host" && value !== "container") {
          throw new Error("--isolation must be 'host' or 'container'");
        }
        isolation = value;
        break;
      }
      case "--execute":
        dryRun = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        // A bare (non-flag) argument is the ssh url for `join`.
        if (!arg.startsWith("--") && !sshUrl) {
          sshUrl = arg;
          break;
        }
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  const platform: A.Platform = process.platform === "linux" ? "linux" : "darwin";
  if (!prefix) prefix = resolve(tmpdir(), "teamctx-dryrun");
  return { users, teamDir, platform, dryRun, prefix, sshUrl, archivePath, isolation };
}

function reloadSshd(platform: A.Platform): A.Command {
  return platform === "darwin"
    ? {
        argv: ["launchctl", "kickstart", "-k", "system/com.openssh.sshd"],
        sudo: true,
        description: "reload sshd",
      }
    : { argv: ["systemctl", "reload", "ssh"], sudo: true, description: "reload sshd" };
}

/** Idempotently strip the teamctx Match block from sshd_config using portable awk (sentinels are shell-safe). */
function removeSshdBlockCommand(): A.Command {
  const script =
    `awk -v b='${A.SSHD_BEGIN}' -v e='${A.SSHD_END}' 'index($0,b){s=1} !s{print} index($0,e){s=0}' ` +
    "/etc/ssh/sshd_config > /tmp/teamctx-sshd && cat /tmp/teamctx-sshd > /etc/ssh/sshd_config && rm -f /tmp/teamctx-sshd";
  return {
    argv: ["bash", "-c", script],
    sudo: true,
    description: "remove the teamctx Match block from sshd_config",
  };
}

function stopServerCommand(platform: A.Platform): A.Command {
  return platform === "darwin"
    ? {
        argv: [
          "launchctl",
          "bootout",
          `gui/${process.getuid?.() ?? 501}/${A.DEFAULTS.serverLabel}`,
        ],
        sudo: false,
        description: "unload the context server LaunchAgent",
      }
    : {
        argv: ["systemctl", "--user", "stop", "teamctx.service"],
        sudo: false,
        description: "stop the context server unit",
      };
}

function serverUnitPath(platform: A.Platform): string {
  return platform === "darwin"
    ? resolve(homedir(), "Library", "LaunchAgents", `${A.DEFAULTS.serverLabel}.plist`)
    : resolve(homedir(), ".config", "systemd", "user", "teamctx.service");
}

/** Remove each guest Unix account (platform-specific). */
function userRemovalCommands(o: LifecycleOptions): A.Command[] {
  return o.users.map((user) =>
    o.platform === "darwin"
      ? {
          argv: ["sysadminctl", "-deleteUser", user],
          sudo: true,
          description: `remove user ${user}`,
        }
      : { argv: ["userdel", "-r", user], sudo: true, description: `remove user ${user} and home` },
  );
}

/** Remove the teamctx group (platform-specific). */
function groupRemovalCommand(o: LifecycleOptions): A.Command {
  return o.platform === "darwin"
    ? {
        argv: ["dseditgroup", "-o", "delete", A.DEFAULTS.group],
        sudo: true,
        description: `remove group ${A.DEFAULTS.group}`,
      }
    : {
        argv: ["groupdel", A.DEFAULTS.group],
        sudo: true,
        description: `remove group ${A.DEFAULTS.group}`,
      };
}

/** `stop` in container mode: disable guest SSH and stop the box; keep the image and /team. */
function buildContainerStopPlan(o: LifecycleOptions): PlanItem[] {
  return [
    {
      id: "sshd-disable",
      title: "Disable guest SSH (remove the Match block)",
      files: [],
      commands: [removeSshdBlockCommand(), reloadSshd(o.platform)],
    },
    {
      id: "box-stop",
      title: "Stop the jail container (image + data kept)",
      files: [],
      commands: [
        {
          argv: ["docker", "stop", C.CONTAINER_DEFAULTS.containerName],
          sudo: true,
          description: "stop the box container",
        },
      ],
    },
    {
      id: "keepawake",
      title: "Release keep-awake",
      files: [],
      commands:
        o.platform === "darwin"
          ? [{ argv: ["pkill", "-x", "caffeinate"], sudo: false, description: "stop caffeinate" }]
          : [],
    },
  ];
}

/** `teardown` in container mode: remove the box + image + host bridge/sudoers + users; archive /team. */
function buildContainerTeardownPlan(o: LifecycleOptions, archivePath: string): PlanItem[] {
  return [
    {
      id: "box-remove",
      title: "Stop and remove the jail container + image",
      files: [],
      commands: [
        {
          argv: ["docker", "rm", "-f", C.CONTAINER_DEFAULTS.containerName],
          sudo: true,
          description: "remove the box container",
        },
        {
          argv: ["docker", "rmi", C.CONTAINER_DEFAULTS.image],
          sudo: true,
          description: "remove the box image",
        },
      ],
    },
    {
      id: "sshd-restore",
      title: "Restore sshd_config",
      files: [],
      commands: [removeSshdBlockCommand(), reloadSshd(o.platform)],
    },
    {
      id: "bridge-remove",
      title: "Remove the host bridge, enter script, and sudoers rule",
      files: [],
      commands: [
        {
          argv: ["rm", "-f", C.CONTAINER_DEFAULTS.bridgePath],
          sudo: true,
          description: `remove ${C.CONTAINER_DEFAULTS.bridgePath}`,
        },
        {
          argv: ["rm", "-f", C.CONTAINER_DEFAULTS.enterPath],
          sudo: true,
          description: `remove ${C.CONTAINER_DEFAULTS.enterPath}`,
        },
        {
          argv: ["rm", "-f", "/etc/sudoers.d/teamctx"],
          sudo: true,
          description: "remove the teamctx sudoers rule",
        },
      ],
    },
    ...(o.users.length > 0
      ? [
          {
            id: "users-remove",
            title: `Remove guest users: ${o.users.join(", ")}`,
            files: [],
            commands: userRemovalCommands(o),
          },
        ]
      : []),
    {
      id: "group-remove",
      title: "Remove the teamctx group",
      files: [],
      commands: [groupRemovalCommand(o)],
    },
    {
      id: "state-remove",
      title: "Remove teamctx state (private homes + build context)",
      files: [],
      commands: [
        {
          argv: ["rm", "-rf", C.CONTAINER_DEFAULTS.homesDir],
          sudo: true,
          description: "remove per-user homes (Claude/gh tokens)",
        },
        {
          argv: ["rm", "-rf", "/var/lib/teamctx/box-build"],
          sudo: true,
          description: "remove the docker build context",
        },
      ],
    },
    {
      id: "archive",
      title: `Archive ${o.teamDir} → ${archivePath}`,
      files: [],
      commands: [
        {
          argv: ["tar", "-czf", archivePath, "-C", dirname(o.teamDir), basename(o.teamDir)],
          sudo: false,
          description: "archive the team folder for the hoster",
        },
      ],
    },
  ];
}

/** `stop`: pause hosting but keep all data (team folder, users, managed settings) intact. */
export function buildStopPlan(o: LifecycleOptions): PlanItem[] {
  if (o.isolation === "container") return buildContainerStopPlan(o);
  return [
    {
      id: "sshd-disable",
      title: "Disable guest SSH (remove the Match block)",
      files: [],
      commands: [removeSshdBlockCommand(), reloadSshd(o.platform)],
    },
    {
      id: "server-stop",
      title: "Stop the context server (data kept)",
      files: [],
      commands: [stopServerCommand(o.platform)],
    },
    {
      id: "keepawake",
      title: "Release keep-awake",
      files: [],
      commands:
        o.platform === "darwin"
          ? [{ argv: ["pkill", "-x", "caffeinate"], sudo: false, description: "stop caffeinate" }]
          : [],
    },
  ];
}

/** `teardown`: reverse everything `host` installed and archive the team folder. */
export function buildTeardownPlan(o: LifecycleOptions, archivePath: string): PlanItem[] {
  if (o.isolation === "container") return buildContainerTeardownPlan(o, archivePath);
  const managedPath = A.MANAGED_SETTINGS_PATH[o.platform];
  const userRemoval = userRemovalCommands(o);
  const groupRemoval = groupRemovalCommand(o);

  return [
    {
      id: "server-remove",
      title: "Stop and remove the context server",
      files: [],
      commands: [
        stopServerCommand(o.platform),
        {
          argv: ["rm", "-f", serverUnitPath(o.platform)],
          sudo: false,
          description: "remove the server unit file",
        },
      ],
    },
    {
      id: "sshd-restore",
      title: "Restore sshd_config",
      files: [],
      commands: [removeSshdBlockCommand(), reloadSshd(o.platform)],
    },
    {
      id: "managed-settings",
      title: "Remove the teamctx managed settings",
      files: [],
      commands: [
        { argv: ["rm", "-f", managedPath], sudo: true, description: `remove ${managedPath}` },
      ],
    },
    {
      id: "shell-remove",
      title: "Remove the ForceCommand shell",
      files: [],
      commands: [
        {
          argv: ["rm", "-f", A.DEFAULTS.shellPath],
          sudo: true,
          description: `remove ${A.DEFAULTS.shellPath}`,
        },
      ],
    },
    ...(o.users.length > 0
      ? [
          {
            id: "users-remove",
            title: `Remove guest users: ${o.users.join(", ")}`,
            files: [],
            commands: userRemoval,
          },
        ]
      : []),
    { id: "group-remove", title: "Remove the teamctx group", files: [], commands: [groupRemoval] },
    {
      id: "archive",
      title: `Archive ${o.teamDir} → ${archivePath}`,
      files: [],
      commands: [
        {
          argv: ["tar", "-czf", archivePath, "-C", dirname(o.teamDir), basename(o.teamDir)],
          sudo: false,
          description: "archive the team folder for the hoster",
        },
      ],
    },
  ];
}

/** `join`: teammate-side convenience. The raw ssh:// link works without this. */
export function buildJoinPlan(o: LifecycleOptions): PlanItem[] {
  const url = o.sshUrl;
  if (!url) throw new Error("teamctx join needs an ssh url, e.g. `teamctx join ssh://alice@host`");
  const open: A.Command =
    o.platform === "darwin"
      ? { argv: ["open", url], sudo: false, description: "open the workspace over SSH" }
      : { argv: ["xdg-open", url], sudo: false, description: "open the workspace over SSH" };
  return [
    {
      id: "tailscale",
      title: "Join the tailnet",
      files: [],
      commands: [{ argv: ["tailscale", "up"], sudo: false, description: "bring up Tailscale" }],
    },
    { id: "open", title: "Open the shared workspace", files: [], commands: [open] },
  ];
}

async function runPlan(
  items: PlanItem[],
  o: LifecycleOptions,
  log: (line: string) => void,
  requireRoot: boolean,
): Promise<LifecycleResult> {
  if (!o.dryRun) {
    if (requireRoot && process.getuid?.() !== 0) {
      throw new Error(
        "this command must be run as root (sudo). Validate on a clean VM first — see README/SECURITY.",
      );
    }
    log("!!! EXECUTE MODE — mutating the machine.");
    return { dryRun: false, written: await executePlanItems(items, log) };
  }
  const written = writePlanDryRun(items, o.prefix, log);
  log("DRY RUN complete — no changes made.");
  return { dryRun: true, written };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function runStop(
  o: LifecycleOptions,
  log: (line: string) => void = defaultLog,
): Promise<LifecycleResult> {
  return runPlan(buildStopPlan(o), o, log, true);
}

export function runTeardown(
  o: LifecycleOptions,
  log: (line: string) => void = defaultLog,
): Promise<LifecycleResult> {
  const archivePath = o.archivePath ?? resolve(homedir(), `team-archive-${timestamp()}.tar.gz`);
  return runPlan(buildTeardownPlan(o, archivePath), o, log, true);
}

export function runJoin(
  o: LifecycleOptions,
  log: (line: string) => void = defaultLog,
): Promise<LifecycleResult> {
  if (!o.sshUrl)
    throw new Error("teamctx join needs an ssh url, e.g. `teamctx join ssh://alice@host`");
  return runPlan(buildJoinPlan(o), o, log, false);
}
