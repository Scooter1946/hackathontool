import { homedir } from "node:os";
import { resolve } from "node:path";

/** Runtime configuration for the context server, all overridable via environment. */
export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
}

/**
 * Resolve server config from the environment. Defaults keep the server on loopback with a
 * SQLite file under ~/.teamctx — the provisioner (Step 3) points these at the /team data dir.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.TEAMCTX_HOST ?? "127.0.0.1";
  const port = Number.parseInt(env.TEAMCTX_PORT ?? "4517", 10);
  const dataDir = env.TEAMCTX_DATA_DIR
    ? resolve(env.TEAMCTX_DATA_DIR)
    : resolve(homedir(), ".teamctx");
  const dbPath = env.TEAMCTX_DB_PATH
    ? resolve(env.TEAMCTX_DB_PATH)
    : resolve(dataDir, "context.sqlite");
  return { host, port, dataDir, dbPath };
}
