/**
 * @teamctx/server — the MCP context server (the product core).
 *
 * A team-wide memory shared across different humans' Claude Code agents: agents post findings,
 * log decisions, and coordinate a lightweight task board through MCP tools over a loopback HTTP
 * transport, persisted in SQLite.
 */
export { Storage } from "./db.js";
export type {
  Finding,
  Decision,
  TeamTask,
  TaskStatus,
  ContextQuery,
  DigestData,
  StorageOptions,
} from "./db.js";
export { createContextServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
export { createApp, startServer, sanitizeIdentity, IDENTITY_HEADER } from "./http.js";
export type { RunningServer } from "./http.js";
export { loadConfig } from "./config.js";
export type { ServerConfig } from "./config.js";
export { formatDigest } from "./digest.js";
