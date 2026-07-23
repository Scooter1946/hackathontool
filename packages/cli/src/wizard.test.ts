import { describe, expect, it } from "vitest";
import type { HostOptions, HostResult } from "./host.js";
import type { ToolStatus } from "./preflight.js";
import {
  collectHostOptions,
  hostCommandLine,
  runHostWizard,
  summarizePreflight,
  type WizardDeps,
  type WizardIO,
} from "./wizard.js";

const baseOptions = (over: Partial<HostOptions> = {}): HostOptions => ({
  users: [],
  teamDir: "/team",
  port: 4517,
  platform: "linux",
  dryRun: true,
  prefix: "/tmp/teamctx-dryrun",
  magicDnsName: "host.ts.net",
  isolation: "host",
  exposes: [],
  ...over,
});

/** A WizardIO that feeds scripted answers and records every prompt + printed line. */
function scriptedIO(answers: string[]): { io: WizardIO; out: string[] } {
  const out: string[] = [];
  let i = 0;
  return {
    out,
    io: {
      question: async (prompt) => {
        out.push(prompt);
        return answers[i++] ?? "";
      },
      print: (line) => out.push(line),
    },
  };
}

const okTool = (tool: string): ToolStatus => ({ tool, present: true, required: true, hint: "" });

function fakeDeps(over: { pf?: ToolStatus[]; root?: boolean } = {}): {
  deps: WizardDeps;
  calls: HostOptions[];
} {
  const calls: HostOptions[] = [];
  const deps: WizardDeps = {
    platform: "linux",
    preflight: async () => over.pf ?? [okTool("node"), okTool("git")],
    runHost: async (o): Promise<HostResult> => {
      calls.push(o);
      return { dryRun: o.dryRun, writtenFiles: [], preflight: [], invites: [] };
    },
    isRoot: () => over.root ?? false,
  };
  return { deps, calls };
}

describe("collectHostOptions", () => {
  it("maps repo, usernames, and port from the answers", async () => {
    const { io } = scriptedIO(["https://github.com/you/p.git", "alice, bob", "5000"]);
    const o = await collectHostOptions(io, baseOptions());
    expect(o?.repoUrl).toBe("https://github.com/you/p.git");
    expect(o?.users).toEqual(["alice", "bob"]);
    expect(o?.port).toBe(5000);
    expect(o?.dryRun).toBe(true);
  });

  it("treats a blank repo as none and a blank port as the default", async () => {
    const { io } = scriptedIO(["", "alice", ""]);
    const o = await collectHostOptions(io, baseOptions({ port: 4517 }));
    expect(o?.repoUrl).toBeUndefined();
    expect(o?.port).toBe(4517);
  });

  it("drops invalid usernames and keeps the valid ones", async () => {
    const { io, out } = scriptedIO(["", "al ice, bob, ok_1", ""]);
    const o = await collectHostOptions(io, baseOptions());
    expect(o?.users).toEqual(["bob", "ok_1"]);
    expect(out.some((l) => l.includes("ignoring invalid username(s): al ice"))).toBe(true);
  });

  it("returns null when no usable usernames are given", async () => {
    const { io } = scriptedIO(["", "", "", ""]);
    const o = await collectHostOptions(io, baseOptions());
    expect(o).toBeNull();
  });

  it("records container isolation when the user opts in", async () => {
    const { io } = scriptedIO(["", "alice", "", "y"]); // repo, users, port, jail=y
    const o = await collectHostOptions(io, baseOptions());
    expect(o?.isolation).toBe("container");
  });
});

describe("hostCommandLine", () => {
  it("includes users, repo, and --execute; omits defaulted port/team-dir", () => {
    const cmd = hostCommandLine(
      baseOptions({ users: ["alice", "bob"], repoUrl: "https://x/y.git" }),
    );
    expect(cmd).toBe("sudo teamctx host --users alice,bob --repo https://x/y.git --execute");
  });

  it("surfaces a non-default port and team-dir", () => {
    const cmd = hostCommandLine(baseOptions({ users: ["a"], port: 5000, teamDir: "/srv/team" }));
    expect(cmd).toContain("--port 5000");
    expect(cmd).toContain("--team-dir /srv/team");
  });

  it("adds --isolation container and --expose flags in container mode", () => {
    const cmd = hostCommandLine(
      baseOptions({
        users: ["a"],
        isolation: "container",
        exposes: [{ host: "/d", container: "/data", readOnly: true }],
      }),
    );
    expect(cmd).toContain("--isolation container");
    expect(cmd).toContain("--expose /d:/data:ro");
  });
});

describe("summarizePreflight", () => {
  it("flags missing required tools with their hints", () => {
    const { lines, missingRequired } = summarizePreflight([
      okTool("node"),
      { tool: "gh", present: false, required: true, hint: "install the GitHub CLI" },
      { tool: "docker", present: false, required: false, hint: "optional" },
    ]);
    expect(missingRequired).toEqual(["gh"]);
    expect(lines.join("\n")).toContain("gh: install the GitHub CLI");
  });

  it("reports all-present cleanly", () => {
    const { missingRequired } = summarizePreflight([okTool("node")]);
    expect(missingRequired).toEqual([]);
  });
});

describe("runHostWizard", () => {
  it("declining apply prints the ready-to-run sudo command and never executes", async () => {
    // answers: repo, users, port, jail, apply
    const { io, out } = scriptedIO(["https://github.com/you/p.git", "alice,bob", "", "n", "n"]);
    const { deps, calls } = fakeDeps();
    const code = await runHostWizard(io, deps);
    expect(code).toBe(0);
    // Exactly one runHost call, and it was the dry-run.
    expect(calls).toHaveLength(1);
    expect(calls[0].dryRun).toBe(true);
    expect(out.some((l) => l.includes("Nothing applied"))).toBe(true);
    expect(
      out.some((l) =>
        l.includes("sudo teamctx host --users alice,bob --repo https://github.com/you/p.git"),
      ),
    ).toBe(true);
  });

  it("accepting apply without root prints the sudo command instead of executing", async () => {
    // repo, users, port, jail=n, apply=y
    const { io, out } = scriptedIO(["", "alice", "", "n", "y"]);
    const { deps, calls } = fakeDeps({ root: false });
    await runHostWizard(io, deps);
    expect(calls).toHaveLength(1); // dry-run only
    expect(calls[0].dryRun).toBe(true);
    expect(out.some((l) => l.includes("Applying needs root"))).toBe(true);
  });

  it("accepting apply as root executes for real", async () => {
    // repo, users, port, jail=n, apply=y
    const { io } = scriptedIO(["", "alice", "", "n", "y"]);
    const { deps, calls } = fakeDeps({ root: true });
    await runHostWizard(io, deps);
    expect(calls).toHaveLength(2);
    expect(calls[0].dryRun).toBe(true);
    expect(calls[1].dryRun).toBe(false); // real execute
  });

  it("aborts before collecting anything if required tools are missing and the user declines", async () => {
    const { io, out } = scriptedIO(["n"]);
    const { deps, calls } = fakeDeps({
      pf: [{ tool: "gh", present: false, required: true, hint: "install gh" }],
    });
    await runHostWizard(io, deps);
    expect(calls).toHaveLength(0);
    expect(out.some((l) => l.includes("Aborted"))).toBe(true);
  });

  it("continues past a missing-tools warning when the user says yes", async () => {
    // continue=y, then repo, users, port, jail, apply
    const { io } = scriptedIO(["y", "", "alice", "", "n", "n"]);
    const { deps, calls } = fakeDeps({
      pf: [{ tool: "gh", present: false, required: true, hint: "install gh" }],
    });
    await runHostWizard(io, deps);
    expect(calls).toHaveLength(1); // reached the dry-run
    expect(calls[0].users).toEqual(["alice"]);
  });
});
