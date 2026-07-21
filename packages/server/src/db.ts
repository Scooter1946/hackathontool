import Database from "better-sqlite3";

export interface Finding {
  id: number;
  author: string;
  text: string;
  tags: string[];
  files: string[];
  createdAt: string;
}

export interface Decision {
  id: number;
  author: string;
  text: string;
  rationale: string | null;
  createdAt: string;
}

export type TaskStatus = "active" | "released";

export interface TeamTask {
  id: number;
  owner: string;
  description: string;
  status: TaskStatus;
  createdAt: string;
  releasedAt: string | null;
}

export interface ContextQuery {
  query?: string;
  since?: string;
  tags?: string[];
  limit?: number;
}

/** The compact team-state summary shown to fresh sessions and returned by get_digest. */
export interface DigestData {
  generatedAt: string;
  decisions: Decision[];
  activeTasks: TeamTask[];
  findings: Finding[];
}

export interface StorageOptions {
  /** SQLite file path; defaults to an in-memory database (used by tests). */
  path?: string;
  /** Clock injection for deterministic tests; defaults to ISO wall-clock time. */
  now?: () => string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`;

type Row = Record<string, unknown>;

/**
 * All team context lives here. A single Storage instance is shared by every MCP session on the
 * host, which is exactly what makes one teammate's findings visible to another's agent.
 */
export class Storage {
  private readonly db: Database.Database;
  private readonly now: () => string;

  constructor(options: StorageOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  addFinding(input: { author: string; text: string; tags?: string[]; files?: string[] }): Finding {
    const result = this.db
      .prepare(
        "INSERT INTO findings (author, text, tags, files, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.author,
        input.text,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.files ?? []),
        this.now(),
      );
    const finding = this.getFinding(Number(result.lastInsertRowid));
    if (!finding) throw new Error("failed to persist finding");
    return finding;
  }

  getFinding(id: number): Finding | undefined {
    const row = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return row ? mapFinding(row) : undefined;
  }

  listFindings(query: ContextQuery = {}): Finding[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.since) {
      clauses.push("created_at >= ?");
      params.push(query.since);
    }
    if (query.query) {
      clauses.push("(text LIKE ? OR tags LIKE ?)");
      params.push(`%${query.query}%`, `%${query.query}%`);
    }
    if (query.tags && query.tags.length > 0) {
      clauses.push(`(${query.tags.map(() => "tags LIKE ?").join(" OR ")})`);
      // Match the JSON-encoded tag, e.g. the substring "api" inside '["api","auth"]'.
      for (const tag of query.tags) params.push(`%${JSON.stringify(tag)}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM findings ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, query.limit ?? 50) as Row[];
    return rows.map(mapFinding);
  }

  addDecision(input: { author: string; text: string; rationale?: string }): Decision {
    const result = this.db
      .prepare("INSERT INTO decisions (author, text, rationale, created_at) VALUES (?, ?, ?, ?)")
      .run(input.author, input.text, input.rationale ?? null, this.now());
    const decision = this.getDecision(Number(result.lastInsertRowid));
    if (!decision) throw new Error("failed to persist decision");
    return decision;
  }

  getDecision(id: number): Decision | undefined {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapDecision(row) : undefined;
  }

  listDecisions(limit = 50): Decision[] {
    const rows = this.db
      .prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(mapDecision);
  }

  claimTask(input: { owner: string; description: string }): TeamTask {
    const result = this.db
      .prepare(
        "INSERT INTO tasks (owner, description, status, created_at) VALUES (?, ?, 'active', ?)",
      )
      .run(input.owner, input.description, this.now());
    const task = this.getTask(Number(result.lastInsertRowid));
    if (!task) throw new Error("failed to persist task");
    return task;
  }

  getTask(id: number): TeamTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTask(row) : undefined;
  }

  /** Mark an active task released. Returns the (updated) task, or undefined if no such task. */
  releaseTask(id: number): TeamTask | undefined {
    this.db
      .prepare(
        "UPDATE tasks SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(this.now(), id);
    return this.getTask(id);
  }

  listTasks(options: { status?: TaskStatus } = {}): TeamTask[] {
    const rows = options.status
      ? (this.db
          .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id ASC")
          .all(options.status) as Row[])
      : (this.db.prepare("SELECT * FROM tasks ORDER BY id ASC").all() as Row[]);
    return rows.map(mapTask);
  }

  digest(options: { decisions?: number; findings?: number } = {}): DigestData {
    return {
      generatedAt: this.now(),
      decisions: this.listDecisions(options.decisions ?? 5),
      activeTasks: this.listTasks({ status: "active" }),
      findings: this.listFindings({ limit: options.findings ?? 8 }),
    };
  }
}

function mapFinding(row: Row): Finding {
  return {
    id: Number(row.id),
    author: String(row.author),
    text: String(row.text),
    tags: parseStringArray(row.tags),
    files: parseStringArray(row.files),
    createdAt: String(row.created_at),
  };
}

function mapDecision(row: Row): Decision {
  return {
    id: Number(row.id),
    author: String(row.author),
    text: String(row.text),
    rationale: row.rationale == null ? null : String(row.rationale),
    createdAt: String(row.created_at),
  };
}

function mapTask(row: Row): TeamTask {
  return {
    id: Number(row.id),
    owner: String(row.owner),
    description: String(row.description),
    status: String(row.status) === "released" ? "released" : "active",
    createdAt: String(row.created_at),
    releasedAt: row.released_at == null ? null : String(row.released_at),
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
