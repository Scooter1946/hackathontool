import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "./host-artifacts.js";

const execFileAsync = promisify(execFile);

export interface PlanFile {
  path: string;
  content: string;
  mode?: number;
}

export interface PlanItem {
  id: string;
  title: string;
  files: PlanFile[];
  commands: Command[];
}

export function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** A privileged command printed for review; never runs any shell here. */
export function describeCommand(command: Command): string {
  return `${command.sudo ? "sudo " : ""}${command.argv.join(" ")}`;
}

/**
 * Dry-run a plan: write each file under `prefix` (so the rendered bytes can be inspected) and print
 * every privileged command without running it. Returns the logical (real-target) paths.
 */
export function writePlanDryRun(
  items: PlanItem[],
  prefix: string,
  log: (line: string) => void,
): string[] {
  const written: string[] = [];
  for (const item of items) {
    log(`# ${item.title}`);
    for (const file of item.files) {
      const rendered = join(prefix, file.path);
      mkdirSync(dirname(rendered), { recursive: true });
      writeFileSync(rendered, file.content, { mode: file.mode ?? 0o644 });
      written.push(file.path);
      log(
        `  would write ${file.path} (${Buffer.byteLength(file.content)} bytes) → rendered at ${rendered}`,
      );
    }
    for (const command of item.commands) {
      log(`  would run: ${describeCommand(command)}   # ${command.description}`);
    }
    log("");
  }
  return written;
}

/**
 * Execute a plan for real: write files to their true paths and run every command. The caller is
 * responsible for privilege checks; this is only reached via an explicit --execute flag.
 */
export async function executePlanItems(
  items: PlanItem[],
  log: (line: string) => void,
): Promise<string[]> {
  const written: string[] = [];
  for (const item of items) {
    log(`# ${item.title}`);
    for (const file of item.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
      written.push(file.path);
    }
    for (const command of item.commands) {
      await execFileAsync(command.argv[0], command.argv.slice(1));
    }
  }
  return written;
}
