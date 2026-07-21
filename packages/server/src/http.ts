import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Storage } from "./db.js";
import { createContextServer } from "./server.js";
import { formatDigest } from "./digest.js";

/**
 * Header that carries the caller's identity. Each teammate's .mcp.json sets this from
 * $TEAMCTX_USER (their Unix username). Because the transport is loopback-only, this header is a
 * convenience identifier, not an authentication boundary — the boundary is the 127.0.0.1 bind
 * plus the OS user separation set up by the provisioner.
 */
export const IDENTITY_HEADER = "x-teamctx-user";

export function sanitizeIdentity(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "unknown";
}

/**
 * Build the Express app. Two surfaces share one storage:
 *   - POST/GET/DELETE /mcp : the MCP Streamable HTTP protocol endpoint (for agents)
 *   - GET /digest, /health : plain endpoints the SessionStart hook / supervisor can curl
 */
export function createApp(storage: Storage): Express {
  const app = express();
  app.use(express.json());

  // One MCP session per teammate's Claude Code session, keyed by the SDK's session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, name: "teamctx-context-server" });
  });

  app.get("/digest", (_req: Request, res: Response) => {
    res.type("text/plain").send(formatDigest(storage.digest()));
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const identity = sanitizeIdentity(req.headers[IDENTITY_HEADER]);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Loopback bind is the boundary; the client sends Host: 127.0.0.1:<port> which would
          // otherwise need to be allow-listed. Keep rebinding protection off for the CLI client.
          enableDnsRebindingProtection: false,
          onsessioninitialized: (sid: string) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await createContextServer(storage, identity).connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "Bad Request: no valid session id (send an initialize request first)",
        },
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal server error" },
        });
      }
    }
  });

  // GET (server->client SSE) and DELETE (session teardown) reuse an existing session.
  const replaySession = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", replaySession);
  app.delete("/mcp", replaySession);

  return app;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Start the HTTP server. Pass port 0 to bind an ephemeral port (used by tests). */
export function startServer(
  storage: Storage,
  options: { host: string; port: number },
): Promise<RunningServer> {
  const app = createApp(storage);
  return new Promise<RunningServer>((resolvePromise) => {
    const httpServer = app.listen(options.port, options.host, () => {
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolvePromise({
        url: `http://${options.host}:${port}/mcp`,
        port,
        close: () =>
          new Promise<void>((done) => {
            httpServer.close(() => done());
          }),
      });
    });
  });
}
