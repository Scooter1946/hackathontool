import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode";
import * as A from "./host-artifacts.js";
import {
  defaultLog,
  executePlanItems,
  type PlanFile,
  type PlanItem,
  writePlanDryRun,
} from "./plan.js";
import { preflight, type ToolStatus } from "./preflight.js";
import { stampTeamFolder } from "./template.js";

const execFileAsync = promisify(execFile);

export interface HostOptions {
  users: string[];
  teamDir: string;
  port: number;
  platform: A.Platform;
  dryRun: boolean;
  prefix: string;
  magicDnsName: string;
  repoUrl?: string;
}

export interface HostResult {
  dryRun: boolean;
  prefix?: string;
  writtenFiles: string[];
  preflight: ToolStatus[];
  invites: string[];
}

/** Resolve the compiled context-server entry point (packages/server/dist/main.js). */
function resolveServerEntry(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@teamctx/server/package.json");
  return resolve(dirname(pkgJson), "dist", "main.js");
}

export function parseHostArgs(argv: string[]): HostOptions {
  let users: string[] = [];
  let teamDir: string = A.DEFAULTS.teamDir;
  let port: number = A.DEFAULTS.port;
  let dryRun = true;
  let prefix = "";
  let magicDnsName = "";
  let repoUrl: string | undefined;

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
      case "--port":
        port = Number.parseInt(argv[++i] ?? "", 10) || port;
        break;
      case "--prefix":
        prefix = argv[++i] ?? "";
        break;
      case "--magic-dns":
        magicDnsName = argv[++i] ?? "";
        break;
      case "--repo":
        repoUrl = argv[++i];
        break;
      case "--execute":
        dryRun = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  const platform: A.Platform = process.platform === "linux" ? "linux" : "darwin";
  if (!prefix) prefix = resolve(tmpdir(), "teamctx-dryrun");
  if (!magicDnsName) magicDnsName = hostname();
  return { users, teamDir, port, platform, dryRun, prefix, magicDnsName, repoUrl };
}

function artifactOptions(o: HostOptions): A.ArtifactOptions {
  return {
    teamDir: o.teamDir,
    port: o.port,
    group: A.DEFAULTS.group,
    shellPath: A.DEFAULTS.shellPath,
    users: o.users,
    platform: o.platform,
    magicDnsName: o.magicDnsName,
    nodePath: process.execPath,
    serverEntry: resolveServerEntry(),
    dataDir: resolve(o.teamDir, ".teamctx-data"),
    home: homedir(),
    repoUrl: o.repoUrl,
  };
}

/** The ordered set of file installs + privileged commands a real `teamctx host` would perform. */
export function buildPlan(o: HostOptions, ao: A.ArtifactOptions): PlanItem[] {
  const managedPath = A.MANAGED_SETTINGS_PATH[o.platform];
  const sshdSnippet = join(ao.dataDir, "sshd_teamctx.conf");

  const userCommands: A.Command[] = [];
  for (const user of o.users) userCommands.push(...A.userCommands(ao, user));

  const sshdReload: A.Command =
    o.platform === "darwin"
      ? {
          argv: ["launchctl", "kickstart", "-k", "system/com.openssh.sshd"],
          sudo: true,
          description: "reload sshd (macOS)",
        }
      : { argv: ["systemctl", "reload", "ssh"], sudo: true, description: "reload sshd (Linux)" };

  const supervisionFile: PlanFile =
    o.platform === "darwin"
      ? {
          path: join(ao.home, "Library", "LaunchAgents", `${A.DEFAULTS.serverLabel}.plist`),
          content: A.renderLaunchdPlist(ao),
        }
      : {
          path: join(ao.home, ".config", "systemd", "user", "teamctx.service"),
          content: A.renderSystemdUnit(ao),
        };
  const supervisionCommand: A.Command =
    o.platform === "darwin"
      ? {
          argv: [
            "launchctl",
            "bootstrap",
            `gui/${process.getuid?.() ?? 501}`,
            supervisionFile.path,
          ],
          sudo: false,
          description: "load the context server LaunchAgent",
        }
      : {
          argv: ["systemctl", "--user", "enable", "--now", "teamctx.service"],
          sudo: false,
          description: "enable + start the context server unit",
        };

  return [
    {
      id: "group",
      title: `Create the '${ao.group}' group`,
      files: [],
      commands: A.groupCommands(ao),
    },
    {
      id: "users",
      title: `Create guest users: ${o.users.join(", ")}`,
      files: [],
      commands: userCommands,
    },
    {
      id: "repo",
      title: `Attach the shared git repo at ${o.teamDir}/repo`,
      files: [],
      commands: A.repoSetupCommands(ao),
    },
    {
      id: "teamdir",
      title: `Group-own and setgid ${o.teamDir}`,
      files: [],
      commands: A.teamDirCommands(ao),
    },
    {
      id: "managed-settings",
      title: `Write machine-wide managed settings (${managedPath})`,
      files: [
        { path: managedPath, content: `${JSON.stringify(A.renderManagedSettings(ao), null, 2)}\n` },
      ],
      commands: [],
    },
    {
      id: "forcecommand-shell",
      title: `Install the ForceCommand shell (${ao.shellPath})`,
      files: [{ path: ao.shellPath, content: A.renderTeamctxShell(ao), mode: 0o755 }],
      commands: [],
    },
    {
      id: "sshd",
      title: "Configure sshd (Match Group block; Tailscale-only)",
      files: [{ path: sshdSnippet, content: A.renderSshdMatchBlock(ao) }],
      commands: [
        {
          argv: [
            "bash",
            "-c",
            `grep -qF '${A.SSHD_BEGIN}' /etc/ssh/sshd_config || cat '${sshdSnippet}' >> /etc/ssh/sshd_config`,
          ],
          sudo: true,
          description: "append the teamctx Match block to sshd_config (idempotent)",
        },
        sshdReload,
      ],
    },
    {
      id: "server",
      title: "Supervise the context server",
      files: [supervisionFile],
      commands: [supervisionCommand],
    },
  ];
}

/**
 * Real provisioning. Gated: requires root and the explicit --execute flag, and is intended to be
 * validated on a clean VM (Step 5) before use on a real host. Not exercised by the test suite.
 */
async function executePlan(
  o: HostOptions,
  ao: A.ArtifactOptions,
  pf: ToolStatus[],
  log: (line: string) => void,
): Promise<HostResult> {
  if (process.getuid?.() !== 0) {
    throw new Error(
      "`teamctx host --execute` must be run as root (sudo). Validate on a clean VM first — see README/SECURITY.",
    );
  }
  log(
    "!!! EXECUTE MODE — this mutates the machine (sshd, users, system settings). Ctrl-C now if unsure.",
  );
  stampTeamFolder(o.teamDir);
  const written = await executePlanItems(buildPlan(o, ao), log);
  await execFileAsync("tailscale", ["up", "--ssh"]).catch(() =>
    log("tailscale up failed — run `tailscale up --ssh` manually"),
  );
  if (o.platform === "darwin") {
    spawn("caffeinate", ["-dimsu"], { detached: true, stdio: "ignore" }).unref();
  }
  return {
    dryRun: false,
    writtenFiles: written,
    preflight: pf,
    invites: o.users.map((u) => A.renderInvite(ao, u)),
  };
}

/**
 * Provision the host. Dry-run (the default) renders every artifact under `prefix` and prints the
 * exact privileged commands a real run would execute, changing nothing on this machine.
 */
export async function runHost(
  o: HostOptions,
  log: (line: string) => void = defaultLog,
): Promise<HostResult> {
  if (o.users.length === 0) throw new Error("teamctx host requires --users <alice,bob,...>");
  const ao = artifactOptions(o);
  const pf = await preflight(o.platform);

  if (!o.dryRun) return executePlan(o, ao, pf, log);

  log(`teamctx host — DRY RUN (${o.platform})`);
  log(`  users:   ${o.users.join(", ")}`);
  log(`  teamDir: ${o.teamDir}`);
  log(`  port:    ${o.port}`);
  log("");
  log("Preflight:");
  for (const c of pf) {
    const state = c.present ? "ok" : c.required ? "MISSING" : "optional";
    log(`  [${state}] ${c.tool}${c.present ? "" : ` — ${c.hint}`}`);
  }
  log("");

  const stampTarget = join(o.prefix, o.teamDir);
  stampTeamFolder(stampTarget);
  log(`Stamped the team-folder template under ${stampTarget}`);
  log("");

  const written = writePlanDryRun(buildPlan(o, ao), o.prefix, log);

  log("# Networking + keep-awake");
  log("  would run: tailscale up --ssh   # Tailscale-only connectivity (no public sshd)");
  log(
    `  would run: ${o.platform === "darwin" ? "caffeinate -dimsu" : "systemd-inhibit --what=idle:sleep sleep infinity"}   # keep the host awake while hosting`,
  );
  const aclPath = join(o.prefix, o.teamDir, ".teamctx-data", "tailscale-acl.jsonc");
  mkdirSync(dirname(aclPath), { recursive: true });
  writeFileSync(aclPath, `${A.renderAclSnippet(ao)}\n`);
  written.push(aclPath);
  log(`  Tailscale ACL snippet rendered at ${aclPath}`);
  log("");

  log("# Invites");
  const invites: string[] = [];
  for (const user of o.users) {
    const invite = A.renderInvite(ao, user);
    invites.push(invite);
    log(invite);
    log(
      await QRCode.toString(`ssh://${user}@${ao.magicDnsName}`, { type: "terminal", small: true }),
    );
  }

  log(`DRY RUN complete — rendered artifacts under ${o.prefix}. No changes made to this machine.`);
  return { dryRun: true, prefix: o.prefix, writtenFiles: written, preflight: pf, invites };
}
