#!/usr/bin/env node
/**
 * teamctx — the provisioner CLI.
 *
 * `teamctx host`     → provision everything, print invites (dry-run by default)
 * `teamctx join`     → teammate-side convenience: join tailnet, open the ssh:// link
 * `teamctx stop`     → pause hosting, keep data
 * `teamctx teardown` → remove users/sshd/settings; archive /team
 *
 * host / stop / teardown are dry-run by default; add --execute (root) to apply for real.
 */
export { stampTeamFolder, TEMPLATE_DIR } from "./template.js";
export type { StampResult } from "./template.js";
export { buildPlan, parseHostArgs, runHost } from "./host.js";
export type { HostOptions, HostResult } from "./host.js";
export {
  buildJoinPlan,
  buildStopPlan,
  buildTeardownPlan,
  parseLifecycleArgs,
  runJoin,
  runStop,
  runTeardown,
} from "./lifecycle.js";
export type { LifecycleOptions, LifecycleResult } from "./lifecycle.js";
export {
  collectHostOptions,
  defaultWizardDeps,
  hostCommandLine,
  makeStdioWizardIO,
  runHostWizard,
  summarizePreflight,
} from "./wizard.js";
export type { WizardDeps, WizardIO } from "./wizard.js";

import { parseHostArgs, runHost } from "./host.js";
import { parseLifecycleArgs, runJoin, runStop, runTeardown } from "./lifecycle.js";
import { defaultWizardDeps, makeStdioWizardIO, runHostWizard } from "./wizard.js";

export const COMMANDS = ["host", "join", "stop", "teardown"] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

const USAGE = `teamctx — shared team context for Claude Code

usage: teamctx <command> [options]

commands:
  host       provision this machine as the team server and print invites
             run with no options (or -i) for an interactive setup wizard
             options: --users <a,b,...>  --team-dir <path>  --port <n>
                      --prefix <dir>  --magic-dns <name>  --repo <url>  --execute
                      --isolation host|container   (container = jail each session in a Linux box)
                      --expose <host[:box][:ro]>   (container mode: extra folders to expose)
  join       join a team as a teammate: teamctx join ssh://<user>@<host>
  stop       pause hosting (keep data)      options: --team-dir <path>  --isolation <mode>  --execute
  teardown   remove everything teamctx added; archive /team
             options: --users <a,b,...>  --team-dir <path>  --archive <path>
                      --isolation <mode>  --execute

host / stop / teardown default to a safe dry-run; add --execute (root) to apply.
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
      case "host": {
        const wantsWizard =
          rest.length === 0 || rest.includes("-i") || rest.includes("--interactive");
        if (wantsWizard) {
          if (!process.stdin.isTTY) {
            process.stderr.write(
              "teamctx host: interactive setup needs a terminal. Pass options directly, e.g.\n" +
                "  teamctx host --users alice,bob --repo <url>              # dry-run\n" +
                "  sudo teamctx host --users alice,bob --repo <url> --execute\n",
            );
            return 1;
          }
          const io = makeStdioWizardIO();
          try {
            return await runHostWizard(io, defaultWizardDeps());
          } finally {
            io.close?.();
          }
        }
        await runHost(parseHostArgs(rest));
        return 0;
      }
      case "join":
        await runJoin(parseLifecycleArgs(rest));
        return 0;
      case "stop":
        await runStop(parseLifecycleArgs(rest));
        return 0;
      case "teardown":
        await runTeardown(parseLifecycleArgs(rest));
        return 0;
    }
  } catch (err) {
    process.stderr.write(`teamctx ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
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
