import { createInterface } from "node:readline/promises";
import { DEFAULTS, type Platform } from "./host-artifacts.js";
import { type HostOptions, type HostResult, parseHostArgs, runHost } from "./host.js";
import { preflight, type ToolStatus } from "./preflight.js";

/**
 * Minimal I/O surface the wizard needs. Injected so the flow can be unit-tested with scripted
 * answers, and so nothing here reads a real TTY or writes to the real machine during tests.
 */
export interface WizardIO {
  question(prompt: string): Promise<string>;
  print(line: string): void;
  close?(): void;
}

/** Side-effecting dependencies, injected for the same reason. */
export interface WizardDeps {
  platform: Platform;
  preflight: (platform: Platform) => Promise<ToolStatus[]>;
  runHost: (o: HostOptions, log: (line: string) => void) => Promise<HostResult>;
  isRoot: () => boolean;
}

/** Unix usernames the provisioner will feed to `useradd`/`dscl`. Conservative on purpose. */
const VALID_USERNAME = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/** The exact non-interactive command that applies the choices the wizard collected. */
export function hostCommandLine(o: HostOptions): string {
  const parts = ["sudo teamctx host", `--users ${o.users.join(",")}`];
  if (o.repoUrl) parts.push(`--repo ${o.repoUrl}`);
  if (o.port !== DEFAULTS.port) parts.push(`--port ${o.port}`);
  if (o.teamDir !== DEFAULTS.teamDir) parts.push(`--team-dir ${o.teamDir}`);
  parts.push("--execute");
  return parts.join(" ");
}

/** Compact preflight view for the top of the wizard; the full per-tool list prints in the dry-run. */
export function summarizePreflight(pf: ToolStatus[]): {
  lines: string[];
  missingRequired: string[];
} {
  const missing = pf.filter((c) => c.required && !c.present);
  const lines: string[] =
    missing.length === 0
      ? ["Preflight: all required tools present."]
      : ["Preflight: missing required tools —", ...missing.map((c) => `  - ${c.tool}: ${c.hint}`)];
  return { lines, missingRequired: missing.map((c) => c.tool) };
}

/**
 * Prompt for the handful of choices a host needs. Pure w.r.t. the machine — it only asks questions
 * and returns options (dry-run). Returns null if the user gives no usable usernames.
 */
export async function collectHostOptions(
  io: WizardIO,
  base: HostOptions,
): Promise<HostOptions | null> {
  io.print("");
  io.print("Let's set up your team host. Press Enter to accept the [default].");
  io.print("");

  const repoAns = (
    await io.question("Git repo URL to share (blank = start an empty repo): ")
  ).trim();
  const repoUrl = repoAns || undefined;

  let users: string[] = [];
  for (let attempt = 0; attempt < 3 && users.length === 0; attempt++) {
    const ans = await io.question("Teammate usernames, comma-separated (e.g. alice,bob): ");
    const raw = ans
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = raw.filter((u) => !VALID_USERNAME.test(u));
    if (bad.length > 0) io.print(`  ignoring invalid username(s): ${bad.join(", ")}`);
    users = raw.filter((u) => VALID_USERNAME.test(u));
    if (users.length === 0) io.print("  (need at least one valid username)");
  }
  if (users.length === 0) {
    io.print("No usernames given — aborting.");
    return null;
  }

  const portAns = (await io.question(`Context-server port [${base.port}]: `)).trim();
  const port = portAns ? Number.parseInt(portAns, 10) || base.port : base.port;

  return { ...base, users, repoUrl, port, dryRun: true };
}

/**
 * Interactive `teamctx host`. Runs preflight, collects choices, renders the full dry-run so the user
 * can review it, then offers to apply. Applying is gated exactly like the flag path: it only runs
 * for real when the user says yes AND is already root; otherwise it prints the `sudo …` command to
 * run. Returns a process exit code.
 */
export async function runHostWizard(io: WizardIO, deps: WizardDeps): Promise<number> {
  io.print("teamctx host — interactive setup");
  io.print("");

  const pf = await deps.preflight(deps.platform);
  const { lines, missingRequired } = summarizePreflight(pf);
  for (const line of lines) io.print(line);
  if (missingRequired.length > 0) {
    const go = await io.question("Some required tools are missing. Continue anyway? [y/N]: ");
    if (!isYes(go)) {
      io.print("Aborted — install the tools above and re-run `teamctx host`.");
      return 0;
    }
  }

  const options = await collectHostOptions(io, parseHostArgs([]));
  if (!options) return 0;

  io.print("");
  io.print(
    `Plan: users=${options.users.join(",")}  repo=${options.repoUrl ?? "(new empty repo)"}  port=${options.port}`,
  );
  io.print("Rendering a dry-run so you can review exactly what would happen…");
  io.print("");
  await deps.runHost(options, io.print);

  io.print("");
  const cmd = hostCommandLine(options);
  const apply = await io.question(
    "Apply this for real now? It needs root and edits sshd/users/system settings [y/N]: ",
  );
  if (!isYes(apply)) {
    io.print("");
    io.print("Nothing applied. When you're ready, run:");
    io.print(`  ${cmd}`);
    return 0;
  }
  if (!deps.isRoot()) {
    io.print("");
    io.print("Applying needs root. Re-run this exact command with sudo:");
    io.print(`  ${cmd}`);
    return 0;
  }
  io.print("");
  await deps.runHost({ ...options, dryRun: false }, io.print);
  return 0;
}

/** Real dependencies for the shipped CLI. */
export function defaultWizardDeps(): WizardDeps {
  return {
    platform: process.platform === "linux" ? "linux" : "darwin",
    preflight,
    runHost,
    isRoot: () => process.getuid?.() === 0,
  };
}

/** Real terminal I/O backed by readline. */
export function makeStdioWizardIO(): WizardIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: (prompt) => rl.question(prompt),
    print: (line) => process.stdout.write(`${line}\n`),
    close: () => rl.close(),
  };
}
