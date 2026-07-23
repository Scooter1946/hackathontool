import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Platform } from "./host-artifacts.js";

const execFileAsync = promisify(execFile);

export interface ToolStatus {
  tool: string;
  present: boolean;
  required: boolean;
  hint: string;
}

/** Read-only check for a binary on PATH. Safe to run in dry-run. */
async function isPresent(bin: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
}

/** Report the tools `teamctx host` relies on. Nothing here mutates the machine. */
export async function preflight(
  platform: Platform,
  opts: { requireDocker?: boolean } = {},
): Promise<ToolStatus[]> {
  const wanted: Omit<ToolStatus, "present">[] = [
    { tool: "node", required: true, hint: "install Node 20+" },
    { tool: "git", required: true, hint: "install git (per-user worktrees)" },
    {
      tool: "gh",
      required: true,
      hint: "install the GitHub CLI — teammates auth as themselves with it",
    },
    {
      tool: "claude",
      required: true,
      hint: "install Claude Code — the hoster runs their own session too",
    },
    {
      tool: "tailscale",
      required: true,
      hint:
        platform === "darwin"
          ? "install the Tailscale app or `brew install tailscale`"
          : "https://tailscale.com/download",
    },
    { tool: "curl", required: true, hint: "install curl (the SessionStart hook uses it)" },
    {
      tool: "docker",
      required: opts.requireDocker ?? false,
      hint: opts.requireDocker
        ? "required for --isolation container (Docker Desktop / OrbStack)"
        : "optional — only if you run the server in Docker",
    },
  ];
  const results: ToolStatus[] = [];
  for (const w of wanted) {
    results.push({ ...w, present: await isPresent(w.tool) });
  }
  return results;
}
