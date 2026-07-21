#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { Storage } from "./db.js";
import { startServer } from "./http.js";

/** Entry point launched by the provisioner's supervisor (launchd/systemd) as `node dist/main.js`. */
async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const storage = new Storage({ path: config.dbPath });
  const running = await startServer(storage, { host: config.host, port: config.port });
  process.stdout.write(`teamctx context server listening on ${running.url}\n`);
  process.stdout.write(`  digest:  http://${config.host}:${running.port}/digest\n`);
  process.stdout.write(`  storage: ${config.dbPath}\n`);

  const shutdown = (): void => {
    running
      .close()
      .catch(() => undefined)
      .finally(() => {
        storage.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`teamctx context server failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
