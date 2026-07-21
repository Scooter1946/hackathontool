import { chmodSync, cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the /team folder template shipped with the CLI. Resolves correctly whether the
 * code runs from src (vitest) or dist (compiled): both sit one level below packages/cli, and the
 * templates directory lives at packages/cli/templates/team.
 */
export const TEMPLATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "team",
);

export interface StampResult {
  teamDir: string;
  repoDir: string;
  worktreesDir: string;
}

/**
 * Stamp the team-folder template into `teamDir`: the config files (CLAUDE.md, .mcp.json,
 * .claude/settings.json, the SessionStart hook) plus the `repo/` clone target and a `worktrees/`
 * directory that holds one git worktree per teammate (each on their own branch). Idempotent:
 * re-stamping overwrites the template files and leaves existing repo/worktree contents in place.
 *
 * Note on auto-connect: the stamped .mcp.json is a project-scoped server, which Claude Code leaves
 * at "pending approval" in an untrusted folder. `teamctx host` closes that gap by pre-approving the
 * server in managed settings, whose approvals apply even in untrusted folders.
 */
export function stampTeamFolder(teamDir: string): StampResult {
  mkdirSync(teamDir, { recursive: true });
  cpSync(TEMPLATE_DIR, teamDir, { recursive: true });

  // cpSync does not guarantee the executable bit survives on every platform; enforce it.
  chmodSync(resolve(teamDir, ".claude", "hooks", "session-digest.sh"), 0o755);

  // repo/ is the shared clone; worktrees/ holds one per-user worktree (each on its own branch).
  const repoDir = resolve(teamDir, "repo");
  const worktreesDir = resolve(teamDir, "worktrees");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });

  return { teamDir, repoDir, worktreesDir };
}
