#!/usr/bin/env node
/**
 * teamctx — the provisioner CLI.
 *
 * `teamctx host`     → provision everything, print invites (Step 3; dry-run by default)
 * `teamctx join`     → teammate-side convenience: join tailnet, open ssh:// link (Step 4)
 * `teamctx stop`     → pause hosting, keep data (Step 4)
 * `teamctx teardown` → remove users/sshd/settings; archive /team (Step 4)
 */
export { stampTeamFolder, TEMPLATE_DIR } from "./template.js";
export type { StampResult } from "./template.js";
export { runHost, parseHostArgs, buildPlan } from "./host.js";
export type { HostOptions, HostResult } from "./host.js";

import { parseHostArgs, runHost } from "./host.js";

export const COMMANDS = ["host", "join", "stop", "teardown"] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

const USAGE = `teamctx — shared team context for Claude Code

usage: teamctx <command> [options]

commands:
  host       provision this machine as the team server and print invites
             (dry-run by default; add --execute to actually apply, root only)
             options: --users <a,b,...>  --team-dir <path>  --port <n>
                      --prefix <dir>  --magic-dns <name>  --execute
  join       join a team as a teammate (Tailscale + ssh)
  stop       pause hosting (keep data)
  teardown   remove everything teamctx added; archive /team
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!isCommand(cmd)) {
    process.stderr.write(`teamctx: unknown command '${cmd}'\n\n${USAGE}`);
    return 1;
  }
  try {
    switch (cmd) {
      case "host":
        await runHost(parseHostArgs(rest));
        return 0;
      default:
        process.stdout.write(`teamctx ${cmd}: not implemented yet\n`);
        return 0;
    }
  } catch (err) {
    process.stderr.write(`teamctx ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    });
}
