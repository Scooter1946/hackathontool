import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArtifactOptions,
  DEFAULTS,
  groupCommands,
  MANAGED_SETTINGS_PATH,
  renderInvite,
  renderManagedSettings,
  renderSshdMatchBlock,
  renderTeamctxShell,
  userCommands,
} from "./host-artifacts.js";
import { parseHostArgs, runHost } from "./host.js";

const ao = (over: Partial<ArtifactOptions> = {}): ArtifactOptions => ({
  teamDir: "/team",
  port: 4517,
  group: "teamctx",
  shellPath: "/usr/local/bin/teamctx-shell",
  users: ["alice", "bob"],
  platform: "darwin",
  magicDnsName: "host.example.ts.net",
  nodePath: "/usr/bin/node",
  serverEntry: "/srv/main.js",
  dataDir: "/team/.teamctx-data",
  home: "/Users/host",
  ...over,
});

describe("host-artifacts renderers", () => {
  it("managed settings grant /team, deny sudo, and pre-approve the MCP server", () => {
    const s = renderManagedSettings(ao());
    expect(s.permissions).toMatchObject({ additionalDirectories: ["/team"] });
    expect((s.permissions as { deny: string[] }).deny).toContain("Bash(sudo *)");
    expect(s.enabledMcpjsonServers).toEqual(["teamctx"]);
  });

  it("sshd block locks the group to the ForceCommand shell with no forwarding", () => {
    const block = renderSshdMatchBlock(ao());
    expect(block).toContain("Match Group teamctx");
    expect(block).toContain("ForceCommand /usr/local/bin/teamctx-shell");
    expect(block).toContain("X11Forwarding no");
    expect(block).toContain("AllowTcpForwarding no");
  });

  it("ForceCommand shell exec()s claude, exposes identity, and offers no shell escape", () => {
    const sh = renderTeamctxShell(ao());
    expect(sh).toContain("exec claude");
    expect(sh).toContain('export TEAMCTX_USER="${USER_NAME}"');
    expect(sh).not.toContain("SSH_ORIGINAL_COMMAND");
  });

  it("builds platform-specific group/user commands", () => {
    expect(groupCommands(ao({ platform: "darwin" }))[0].argv).toContain("dseditgroup");
    expect(groupCommands(ao({ platform: "linux" }))[0].argv).toContain("groupadd");
    expect(userCommands(ao({ platform: "linux" }), "carol")[0].argv).toContain("useradd");
  });

  it("invite includes the ssh url and the own-account login note", () => {
    const inv = renderInvite(ao(), "alice");
    expect(inv).toContain("ssh://alice@host.example.ts.net");
    expect(inv.toLowerCase()).toContain("your own claude");
  });

  it("knows the verified macOS managed-settings path and default port", () => {
    expect(MANAGED_SETTINGS_PATH.darwin).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    expect(DEFAULTS.port).toBe(4517);
  });
});

describe("parseHostArgs", () => {
  it("parses users and defaults to a safe dry-run", () => {
    const o = parseHostArgs(["--users", "alice, bob", "--port", "5000"]);
    expect(o.users).toEqual(["alice", "bob"]);
    expect(o.port).toBe(5000);
    expect(o.dryRun).toBe(true);
  });

  it("--execute turns off dry-run; unknown args throw", () => {
    expect(parseHostArgs(["--users", "a", "--execute"]).dryRun).toBe(false);
    expect(() => parseHostArgs(["--nope"])).toThrow();
  });
});

describe("runHost dry-run", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("renders every artifact under the prefix and runs no privileged commands", async () => {
    dir = resolve(tmpdir(), `teamctx-host-${process.pid}`);
    const lines: string[] = [];
    const result = await runHost(
      {
        users: ["alice", "bob"],
        teamDir: "/team",
        port: 4517,
        platform: "darwin",
        dryRun: true,
        prefix: dir,
        magicDnsName: "host.ts.net",
      },
      (line) => lines.push(line),
    );

    expect(result.dryRun).toBe(true);
    expect(result.invites).toHaveLength(2);

    const managed = join(dir, MANAGED_SETTINGS_PATH.darwin);
    expect(existsSync(managed)).toBe(true);
    expect(
      (JSON.parse(readFileSync(managed, "utf8")) as { enabledMcpjsonServers: string[] })
        .enabledMcpjsonServers,
    ).toEqual(["teamctx"]);
    expect(existsSync(join(dir, "/usr/local/bin/teamctx-shell"))).toBe(true);
    expect(existsSync(join(dir, "/team", "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "/team", ".mcp.json"))).toBe(true);

    const out = lines.join("\n");
    expect(out).toContain("would run: sudo");
    expect(out).toContain("DRY RUN complete");
  });
});
