import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, MANAGED_SETTINGS_PATH, SSHD_BEGIN } from "./host-artifacts.js";
import {
  buildJoinPlan,
  buildStopPlan,
  buildTeardownPlan,
  type LifecycleOptions,
  parseLifecycleArgs,
  runJoin,
  runStop,
  runTeardown,
} from "./lifecycle.js";
import type { PlanItem } from "./plan.js";

const opts = (over: Partial<LifecycleOptions> = {}): LifecycleOptions => ({
  users: ["alice", "bob"],
  teamDir: "/team",
  platform: "darwin",
  dryRun: true,
  prefix: resolve(tmpdir(), "teamctx-lifecycle-test"),
  ...over,
});

const flatCommands = (items: PlanItem[]): string[] =>
  items.flatMap((i) => i.commands.map((c) => c.argv.join(" ")));

describe("parseLifecycleArgs", () => {
  it("reads a positional ssh url (join) and defaults to a safe dry-run", () => {
    const o = parseLifecycleArgs(["ssh://alice@host"]);
    expect(o.sshUrl).toBe("ssh://alice@host");
    expect(o.dryRun).toBe(true);
  });

  it("reads --users and --execute", () => {
    const o = parseLifecycleArgs(["--users", "a, b", "--execute"]);
    expect(o.users).toEqual(["a", "b"]);
    expect(o.dryRun).toBe(false);
  });
});

describe("stop plan", () => {
  it("removes the sshd block and stops the server without deleting data", () => {
    const cmds = flatCommands(buildStopPlan(opts()));
    expect(cmds.some((c) => c.includes("awk") && c.includes("sshd_config"))).toBe(true);
    expect(cmds.some((c) => c.includes("bootout"))).toBe(true);
    // "keeps data": stop must not remove users, managed settings, or archive the team folder.
    expect(cmds.some((c) => c.includes("deleteUser") || c.includes("userdel"))).toBe(false);
    expect(cmds.some((c) => c.includes("managed-settings.json"))).toBe(false);
    expect(cmds.some((c) => c.includes("tar -czf"))).toBe(false);
  });
});

describe("teardown plan reverses host and archives", () => {
  it("removes users, group, managed settings, shell, and the sshd block, then tars /team", () => {
    const cmds = flatCommands(buildTeardownPlan(opts(), "/Users/host/team-archive.tar.gz"));
    expect(cmds.some((c) => c.includes("sysadminctl -deleteUser alice"))).toBe(true);
    expect(cmds.some((c) => c.includes("dseditgroup -o delete teamctx"))).toBe(true);
    expect(cmds.some((c) => c.includes(`rm -f ${MANAGED_SETTINGS_PATH.darwin}`))).toBe(true);
    expect(cmds.some((c) => c.includes(`rm -f ${DEFAULTS.shellPath}`))).toBe(true);
    expect(cmds.some((c) => c.includes(SSHD_BEGIN))).toBe(true);
    expect(cmds.some((c) => c.includes("tar -czf /Users/host/team-archive.tar.gz"))).toBe(true);
  });
});

describe("join plan", () => {
  it("brings up Tailscale and opens the ssh url", () => {
    const cmds = flatCommands(buildJoinPlan(opts({ sshUrl: "ssh://alice@host" })));
    expect(cmds).toContain("tailscale up");
    expect(cmds.some((c) => c.startsWith("open ssh://alice@host"))).toBe(true);
  });

  it("throws without an ssh url", () => {
    expect(() => buildJoinPlan(opts({ sshUrl: undefined }))).toThrow();
  });
});

describe("dry-run runners change nothing", () => {
  it("stop / teardown / join all report dry-run", async () => {
    const noop = (): void => undefined;
    expect((await runStop(opts(), noop)).dryRun).toBe(true);
    expect((await runTeardown(opts(), noop)).dryRun).toBe(true);
    expect((await runJoin(opts({ sshUrl: "ssh://a@h" }), noop)).dryRun).toBe(true);
  });
});
