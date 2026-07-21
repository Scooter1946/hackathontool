/**
 * The capstone: the full shared-context loop that teamctx exists to enable, exercised end-to-end
 * without SSH. Teammate A posts a finding through the MCP server; teammate B's SessionStart hook
 * (the real shell script) fetches the digest and sees it; B's agent then reads the detail via
 * get_context. The SSH / ForceCommand / deny-rule layers require `--execute` on a VM and are
 * covered by the manual checklist in VERIFICATION.md.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Storage, startServer, type RunningServer } from "@teamctx/server";
import { stampTeamFolder } from "./template.js";

const execFileAsync = promisify(execFile);

interface Conn {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function connectAs(url: string, user: string): Promise<Conn> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "X-Teamctx-User": user } },
  });
  const client = new Client({ name: `session-${user}`, version: "0.0.0" });
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

describe("full shared-context loop across two teammates", () => {
  let server: RunningServer | undefined;
  let storage: Storage | undefined;
  let dir: string | undefined;
  const conns: Conn[] = [];

  afterEach(async () => {
    for (const c of conns) await c.client.close();
    conns.length = 0;
    await server?.close();
    storage?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    server = undefined;
    storage = undefined;
    dir = undefined;
  });

  it("A posts a finding → B's SessionStart digest shows it → B reads detail via get_context", async () => {
    // One shared server + one stamped team folder — exactly what `teamctx host` sets up.
    storage = new Storage();
    server = await startServer(storage, { host: "127.0.0.1", port: 0 });
    dir = mkdtempSync(resolve(tmpdir(), "teamctx-loop-"));
    const teamDir = resolve(dir, "team");
    stampTeamFolder(teamDir);

    // Teammate A shares a discovery through the MCP tool.
    const alice = await connectAs(server.url, "alice");
    conns.push(alice);
    await alice.client.callTool({
      name: "post_finding",
      arguments: { text: "the prod DB is read-only on weekends", tags: ["db"] },
    });

    // Teammate B starts a session: the real SessionStart hook fetches the digest.
    const hook = resolve(teamDir, ".claude", "hooks", "session-digest.sh");
    const digestUrl = server.url.replace(/\/mcp$/, "/digest");
    const { stdout: injected } = await execFileAsync("bash", [hook], {
      env: { ...process.env, TEAMCTX_DIGEST_URL: digestUrl },
      encoding: "utf8",
    });
    expect(injected).toContain("the prod DB is read-only on weekends");

    // B's agent then pulls the detail via the MCP tool, correctly attributed to A.
    const bob = await connectAs(server.url, "bob");
    conns.push(bob);
    const context = textOf(
      await bob.client.callTool({ name: "get_context", arguments: { query: "read-only" } }),
    );
    expect(context).toContain("the prod DB is read-only on weekends");
    expect(context).toContain("alice");
  });
});
