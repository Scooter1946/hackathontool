/**
 * @teamctx/server — the MCP context server.
 *
 * This is the product core: a team-wide memory shared across different humans' Claude Code
 * agents. Step 1 implements the Streamable HTTP transport, SQLite storage, and the tool set
 * (post_finding, get_context, log_decision, claim_task/release_task/list_tasks, get_digest).
 *
 * For now this module only exposes server identity so the scaffold has something to test.
 */
export const SERVER_NAME = "teamctx-context-server";

export interface ServerInfo {
  name: string;
  version: string;
}

export function serverInfo(): ServerInfo {
  return { name: SERVER_NAME, version: "0.0.0" };
}
