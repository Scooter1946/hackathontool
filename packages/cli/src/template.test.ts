import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage, startServer, type RunningServer } from "@teamctx/server";
import { stampTeamFolder } from "./template.js";

// Async exec: execFileSync would block the event loop, starving the in-process HTTP server so
// curl can never get a response. Running the child asynchronously keeps the server responsive.
const execFileAsync = promisify(execFile);

describe("stampTeamFolder", () => {
  let dir: string | undefined;
  let server: RunningServer | undefined;
  let storage: Storage | undefined;

  afterEach(async () => {
    await server?.close();
    storage?.close();
    server = undefined;
    storage = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stamps the config files, the repo clone target, and the worktrees dir", () => {
    dir = mkdtempSync(resolve(tmpdir(), "teamctx-"));
    const teamDir = resolve(dir, "team");
    const result = stampTeamFolder(teamDir);

    expect(existsSync(resolve(teamDir, "CLAUDE.md"))).toBe(true);

    const mcp = JSON.parse(readFileSync(resolve(teamDir, ".mcp.json"), "utf8")) as {
      mcpServers: { teamctx: { type: string; url: string; headers: Record<string, string> } };
    };
    expect(mcp.mcpServers.teamctx.type).toBe("http");
    expect(mcp.mcpServers.teamctx.url).toContain("/mcp");
    expect(mcp.mcpServers.teamctx.headers["X-Teamctx-User"]).toContain("TEAMCTX_USER");

    const settings = JSON.parse(
      readFileSync(resolve(teamDir, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(settings.hooks.SessionStart.length).toBeGreaterThan(0);

    expect(existsSync(result.repoDir)).toBe(true);
    expect(existsSync(result.worktreesDir)).toBe(true);
  });

  it("runs the SessionStart hook end-to-end against a live server", async () => {
    dir = mkdtempSync(resolve(tmpdir(), "teamctx-"));
    const teamDir = resolve(dir, "team");
    stampTeamFolder(teamDir);

    storage = new Storage();
    storage.addFinding({ author: "alice", text: "watch out: the staging build is flaky" });
    server = await startServer(storage, { host: "127.0.0.1", port: 0 });

    const hook = resolve(teamDir, ".claude", "hooks", "session-digest.sh");
    const digestUrl = server.url.replace(/\/mcp$/, "/digest");
    const { stdout: out } = await execFileAsync("bash", [hook], {
      env: { ...process.env, TEAMCTX_DIGEST_URL: digestUrl },
      encoding: "utf8",
    });

    expect(out).toContain("shared team context");
    expect(out).toContain("the staging build is flaky");
  });

  it("prints a graceful note when the server is unreachable", async () => {
    dir = mkdtempSync(resolve(tmpdir(), "teamctx-"));
    const teamDir = resolve(dir, "team");
    stampTeamFolder(teamDir);

    const hook = resolve(teamDir, ".claude", "hooks", "session-digest.sh");
    // Point at a port nothing is listening on; the hook must still exit 0.
    const { stdout: out } = await execFileAsync("bash", [hook], {
      env: { ...process.env, TEAMCTX_DIGEST_URL: "http://127.0.0.1:1/digest" },
      encoding: "utf8",
    });
    expect(out).toContain("not reachable");
  });
});
