#!/usr/bin/env node
/**
 * teamctx — the provisioner CLI.
 *
 * `teamctx host`     → provision everything, print invites (Step 3)
 * `teamctx join`     → teammate-side convenience: join tailnet, open ssh:// link (Step 4)
 * `teamctx stop`     → pause hosting, keep data (Step 4)
 * `teamctx teardown` → remove users/sshd/settings; archive /team (Step 4)
 *
 * This scaffold wires up command dispatch; the commands are implemented in later steps.
 */
export { stampTeamFolder, TEMPLATE_DIR } from "./template.js";
export type { StampResult } from "./template.js";

export const COMMANDS = ["host", "join", "stop", "teardown"] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

const USAGE = `teamctx — shared team context for Claude Code

usage: teamctx <command>

commands:
  host       provision this machine as the team server and print invites
  join       join a team as a teammate (Tailscale + ssh)
  stop       pause hosting (keep data)
  teardown   remove everything teamctx added; archive /team
`;

export function main(argv: string[]): number {
  const [cmd] = argv;
  if (!cmd) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!isCommand(cmd)) {
    process.stderr.write(`teamctx: unknown command '${cmd}'\n\n${USAGE}`);
    return 1;
  }
  process.stdout.write(`teamctx ${cmd}: not implemented yet\n`);
  return 0;
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
