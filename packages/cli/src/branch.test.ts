import { describe, expect, it } from "vitest";
import { type ArtifactOptions, renderTeamctxShell, repoSetupCommands } from "./host-artifacts.js";
import { parseHostArgs } from "./host.js";

const ao = (over: Partial<ArtifactOptions> = {}): ArtifactOptions => ({
  teamDir: "/team",
  port: 4517,
  group: "teamctx",
  shellPath: "/usr/local/bin/teamctx-shell",
  users: ["alice"],
  platform: "darwin",
  magicDnsName: "host.ts.net",
  nodePath: "/usr/bin/node",
  serverEntry: "/srv/main.js",
  dataDir: "/team/.teamctx-data",
  home: "/Users/host",
  ...over,
});

describe("per-user branch allocation", () => {
  it("the ForceCommand shell allocates a per-user branch + worktree on connect", () => {
    const sh = renderTeamctxShell(ao());
    expect(sh).toContain('WORKDIR="${TEAM_DIR}/worktrees/${USER_NAME}"');
    expect(sh).toContain('BRANCH="teamctx/${USER_NAME}"');
    expect(sh).toContain('git -C "${REPO}" worktree add');
    expect(sh).toContain("exec claude");
  });

  it("repoSetupCommands clones a given remote (else inits) and configures multi-user git", () => {
    const withRepo = repoSetupCommands(ao({ repoUrl: "https://github.com/you/project.git" })).map(
      (c) => c.argv.join(" "),
    );
    expect(withRepo.some((c) => c.startsWith("git clone https://github.com/you/project.git"))).toBe(
      true,
    );
    expect(withRepo.some((c) => c.includes("safe.directory"))).toBe(true);
    expect(withRepo.some((c) => c.includes("core.sharedRepository group"))).toBe(true);

    const noRepo = repoSetupCommands(ao()).map((c) => c.argv.join(" "));
    expect(noRepo.some((c) => c.startsWith("git init"))).toBe(true);
  });

  it("parseHostArgs reads --repo", () => {
    expect(parseHostArgs(["--users", "a", "--repo", "https://x/y.git"]).repoUrl).toBe(
      "https://x/y.git",
    );
  });
});
