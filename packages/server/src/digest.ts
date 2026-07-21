import type { DigestData } from "./db.js";

/**
 * Render the team-state digest as plain text. This is what the SessionStart hook injects into
 * every fresh Claude Code session (via GET /digest) and what the get_digest tool returns.
 * Kept short on purpose — agents act on short, scannable context.
 */
export function formatDigest(d: DigestData): string {
  const lines: string[] = [];
  lines.push("=== teamctx — shared team context ===");
  lines.push(`(updated ${d.generatedAt})`);
  lines.push("");

  lines.push("DECISIONS (most recent):");
  if (d.decisions.length === 0) {
    lines.push("  (none yet)");
  } else {
    for (const dec of d.decisions) {
      lines.push(`  - [${dec.author}] ${dec.text}${dec.rationale ? ` — ${dec.rationale}` : ""}`);
    }
  }
  lines.push("");

  lines.push("ACTIVE TASKS (who is doing what):");
  if (d.activeTasks.length === 0) {
    lines.push("  (none claimed)");
  } else {
    for (const t of d.activeTasks) {
      lines.push(`  - #${t.id} ${t.owner}: ${t.description}`);
    }
  }
  lines.push("");

  lines.push("RECENT FINDINGS:");
  if (d.findings.length === 0) {
    lines.push("  (none yet)");
  } else {
    for (const f of d.findings) {
      const tags = f.tags.length > 0 ? ` [${f.tags.join(", ")}]` : "";
      lines.push(`  - [${f.author}] ${f.text}${tags}`);
    }
  }
  lines.push("");

  lines.push(
    "Before starting work call get_context. After learning something a teammate could hit call " +
      "post_finding. Record irreversible choices with log_decision. Claim work with claim_task.",
  );
  return lines.join("\n");
}
