import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Storage } from "./db.js";
import { startServer, type RunningServer } from "./http.js";

interface Conn {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function connectAs(url: string, user: string): Promise<Conn> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "X-Teamctx-User": user } },
  });
  const client = new Client({ name: `test-${user}`, version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("MCP context server — two users share context", () => {
  let server: RunningServer | undefined;
  let storage: Storage | undefined;
  const conns: Conn[] = [];

  afterEach(async () => {
    for (const c of conns) await c.client.close();
    conns.length = 0;
    await server?.close();
    storage?.close();
    server = undefined;
    storage = undefined;
  });

  async function boot(): Promise<string> {
    storage = new Storage();
    server = await startServer(storage, { host: "127.0.0.1", port: 0 });
    return server.url;
  }

  it("surfaces one user's finding in another user's context, attributed correctly", async () => {
    const url = await boot();

    const alice = await connectAs(url, "alice");
    conns.push(alice);
    const posted = await alice.client.callTool({
      name: "post_finding",
      arguments: { text: "the payments API is rate-limited to 5 req/s", tags: ["api", "payments"] },
    });
    expect(textOf(posted)).toContain("as alice");

    const bob = await connectAs(url, "bob");
    conns.push(bob);
    const ctx = await bob.client.callTool({ name: "get_context", arguments: {} });
    const text = textOf(ctx);
    expect(text).toContain("rate-limited to 5 req/s");
    expect(text).toContain("alice");
  });

  it("runs the task board across users", async () => {
    const url = await boot();

    const alice = await connectAs(url, "alice");
    conns.push(alice);
    expect(
      textOf(
        await alice.client.callTool({
          name: "claim_task",
          arguments: { description: "build auth" },
        }),
      ),
    ).toContain("Claimed task #1");

    const bob = await connectAs(url, "bob");
    conns.push(bob);
    expect(textOf(await bob.client.callTool({ name: "list_tasks", arguments: {} }))).toContain(
      "alice: build auth",
    );
  });

  it("exposes the plain-text digest for the SessionStart hook", async () => {
    const url = await boot();
    const alice = await connectAs(url, "alice");
    conns.push(alice);
    await alice.client.callTool({
      name: "log_decision",
      arguments: { text: "we switched the schema to v2" },
    });

    const digestUrl = url.replace(/\/mcp$/, "/digest");
    const body = await (await fetch(digestUrl)).text();
    expect(body).toContain("shared team context");
    expect(body).toContain("we switched the schema to v2");
  });
});
