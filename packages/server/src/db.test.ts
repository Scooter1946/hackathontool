import { describe, expect, it } from "vitest";
import { Storage } from "./db.js";

/** Deterministic clock: 2026-07-21T00:00:00Z, incrementing one second per call. */
function fixedClock(): () => string {
  let seconds = 0;
  return () => `2026-07-21T00:00:${String(seconds++).padStart(2, "0")}.000Z`;
}

describe("Storage — findings", () => {
  it("records and retrieves a finding with author, tags, and files", () => {
    const s = new Storage({ now: fixedClock() });
    const f = s.addFinding({
      author: "alice",
      text: "payments API rate-limited",
      tags: ["api", "payments"],
      files: ["src/pay.ts"],
    });
    expect(f.id).toBe(1);
    expect(f.author).toBe("alice");
    expect(f.tags).toEqual(["api", "payments"]);
    expect(f.files).toEqual(["src/pay.ts"]);
    expect(s.getFinding(1)?.text).toContain("rate-limited");
    s.close();
  });

  it("filters by query and by tag", () => {
    const s = new Storage({ now: fixedClock() });
    s.addFinding({ author: "alice", text: "payments API rate-limited", tags: ["api"] });
    s.addFinding({ author: "bob", text: "logo needs dark mode", tags: ["ui"] });
    expect(s.listFindings({ query: "rate-limited" }).map((f) => f.author)).toEqual(["alice"]);
    expect(s.listFindings({ tags: ["ui"] }).map((f) => f.author)).toEqual(["bob"]);
    expect(s.listFindings().length).toBe(2);
    s.close();
  });

  it("filters by since timestamp", () => {
    const s = new Storage({ now: fixedClock() });
    s.addFinding({ author: "a", text: "first" }); // ...00Z
    s.addFinding({ author: "b", text: "second" }); // ...01Z
    const recent = s.listFindings({ since: "2026-07-21T00:00:01.000Z" });
    expect(recent.map((f) => f.text)).toEqual(["second"]);
    s.close();
  });
});

describe("Storage — decisions", () => {
  it("appends decisions with optional rationale", () => {
    const s = new Storage({ now: fixedClock() });
    const d = s.addDecision({ author: "alice", text: "use SQLite", rationale: "boring tech" });
    expect(d.rationale).toBe("boring tech");
    expect(s.addDecision({ author: "bob", text: "no rationale" }).rationale).toBeNull();
    expect(s.listDecisions().length).toBe(2);
    s.close();
  });
});

describe("Storage — tasks", () => {
  it("claims, lists, and releases tasks", () => {
    const s = new Storage({ now: fixedClock() });
    const t = s.claimTask({ owner: "bob", description: "auth flow" });
    expect(t.status).toBe("active");
    expect(s.listTasks({ status: "active" }).length).toBe(1);

    const released = s.releaseTask(t.id);
    expect(released?.status).toBe("released");
    expect(released?.releasedAt).not.toBeNull();
    expect(s.listTasks({ status: "active" }).length).toBe(0);
    s.close();
  });

  it("returns undefined when releasing a missing task", () => {
    const s = new Storage({ now: fixedClock() });
    expect(s.releaseTask(999)).toBeUndefined();
    s.close();
  });
});

describe("Storage — digest", () => {
  it("summarizes decisions, active tasks, and findings", () => {
    const s = new Storage({ now: fixedClock() });
    s.addFinding({ author: "alice", text: "finding one" });
    s.addDecision({ author: "bob", text: "decided one" });
    s.claimTask({ owner: "carol", description: "task one" });
    const d = s.digest();
    expect(d.findings.length).toBe(1);
    expect(d.decisions.length).toBe(1);
    expect(d.activeTasks.length).toBe(1);
    expect(d.generatedAt).toMatch(/^2026-07-21T/);
    s.close();
  });
});
