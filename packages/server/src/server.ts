import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Storage } from "./db.js";
import { formatDigest } from "./digest.js";

export const SERVER_NAME = "teamctx-context-server";
export const SERVER_VERSION = "0.1.0";

function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Build an MCP server bound to a single caller identity. One of these is created per MCP session
 * (i.e. per teammate's Claude Code session); they all share the same Storage, so a finding posted
 * by one user is immediately visible to every other user's agent.
 */
export function createContextServer(storage: Storage, identity: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "post_finding",
    {
      title: "Post a team finding",
      description:
        "Share a discovery a teammate could hit — a gotcha, constraint, or fact you learned while working " +
        "(e.g. 'the payments API is rate-limited to 5 req/s'). Call this after you learn anything non-obvious. " +
        "Your identity and a timestamp are recorded automatically.",
      inputSchema: {
        text: z.string().min(1).describe("The finding, in one or two sentences."),
        tags: z.array(z.string()).optional().describe("Short topical tags, e.g. ['api','auth']."),
        files: z.array(z.string()).optional().describe("Relevant file paths, if any."),
      },
    },
    async ({ text, tags, files }) => {
      const finding = storage.addFinding({ author: identity, text, tags, files });
      return toolText(`Recorded finding #${finding.id} (as ${finding.author}).`);
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get shared team context",
      description:
        "Retrieve what the team already knows — call this before starting a task or when you hit something " +
        "unfamiliar. With no arguments it returns recent findings, decisions, and who is working on what. " +
        "Pass query to keyword-search findings, tags to filter by topic, or since (ISO-8601) for recent-only.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to search findings for."),
        since: z
          .string()
          .optional()
          .describe("ISO-8601 timestamp; only return context at or after this time."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Only return findings carrying any of these tags."),
      },
    },
    async ({ query, since, tags }) => toolText(renderContext(storage, { query, since, tags })),
  );

  server.registerTool(
    "log_decision",
    {
      title: "Log a team decision",
      description:
        "Record an irreversible or team-wide choice so nobody silently undoes it (e.g. 'switched the DB schema " +
        "to X'). Append-only. Include a short rationale when the reasoning isn't obvious.",
      inputSchema: {
        text: z.string().min(1).describe("The decision, stated plainly."),
        rationale: z.string().optional().describe("Why the decision was made."),
      },
    },
    async ({ text, rationale }) => {
      const decision = storage.addDecision({ author: identity, text, rationale });
      return toolText(`Logged decision #${decision.id} (as ${decision.author}).`);
    },
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim a task",
      description:
        "Announce you are starting a piece of work so teammates don't duplicate it. Claim before you start. " +
        "Returns a task id; release it with release_task when you're done.",
      inputSchema: {
        description: z.string().min(1).describe("What you are about to work on."),
      },
    },
    async ({ description }) => {
      const task = storage.claimTask({ owner: identity, description });
      return toolText(`Claimed task #${task.id} for ${task.owner}: ${task.description}`);
    },
  );

  server.registerTool(
    "release_task",
    {
      title: "Release a task",
      description:
        "Mark a task you claimed as done (or no longer yours). Pass the task id from claim_task or list_tasks.",
      inputSchema: {
        id: z.number().int().positive().describe("The task id to release."),
      },
    },
    async ({ id }) => {
      const task = storage.releaseTask(id);
      if (!task) return toolText(`No task #${id} found.`);
      if (task.status === "active")
        return toolText(`Task #${id} could not be released (still active).`);
      return toolText(`Released task #${id} (${task.owner}: ${task.description}).`);
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List active tasks",
      description: "See who on the team is working on what right now (active claims).",
      inputSchema: {},
    },
    async () => {
      const tasks = storage.listTasks({ status: "active" });
      if (tasks.length === 0) return toolText("No active tasks claimed.");
      return toolText(tasks.map((t) => `#${t.id} ${t.owner}: ${t.description}`).join("\n"));
    },
  );

  server.registerTool(
    "get_digest",
    {
      title: "Get the team context digest",
      description:
        "A compact summary of current team state: recent decisions, active task claims, and top findings. " +
        "This is what fresh sessions are shown automatically; call it anytime for a quick refresh.",
      inputSchema: {},
    },
    async () => toolText(formatDigest(storage.digest())),
  );

  return server;
}

function renderContext(
  storage: Storage,
  q: { query?: string; since?: string; tags?: string[] },
): string {
  const findings = storage.listFindings({
    query: q.query,
    since: q.since,
    tags: q.tags,
    limit: 25,
  });
  const decisions = storage.listDecisions(10);
  const activeTasks = storage.listTasks({ status: "active" });

  const scope = q.query
    ? `query "${q.query}"`
    : q.tags && q.tags.length > 0
      ? `tags ${q.tags.join(", ")}`
      : "recent";

  const lines: string[] = [`Team context (${scope}):`, ""];

  lines.push(`FINDINGS (${findings.length}):`);
  if (findings.length === 0) {
    lines.push("  (none matched)");
  } else {
    for (const f of findings) {
      const meta = [
        f.tags.length > 0 ? `tags: ${f.tags.join(", ")}` : "",
        f.files.length > 0 ? `files: ${f.files.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      lines.push(`  #${f.id} [${f.author}] ${f.createdAt}: ${f.text}${meta ? `  (${meta})` : ""}`);
    }
  }
  lines.push("");

  lines.push(`DECISIONS (${decisions.length}):`);
  if (decisions.length === 0) {
    lines.push("  (none yet)");
  } else {
    for (const d of decisions) {
      lines.push(`  #${d.id} [${d.author}] ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`);
    }
  }
  lines.push("");

  lines.push(`ACTIVE TASKS (${activeTasks.length}):`);
  if (activeTasks.length === 0) {
    lines.push("  (none claimed)");
  } else {
    for (const t of activeTasks) {
      lines.push(`  #${t.id} ${t.owner}: ${t.description}`);
    }
  }

  return lines.join("\n");
}
