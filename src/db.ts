import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const SCHEMA_VERSION = 2;

let database: DatabaseSync | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  grants_json TEXT NOT NULL DEFAULT '[]',
  denies_json TEXT NOT NULL DEFAULT '[]',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_projects (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS selected_projects (
  path TEXT PRIMARY KEY,
  selected_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  submitted_by TEXT NOT NULL,
  status TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parent_job_id TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_submitted ON jobs(submitted_by);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_path TEXT NOT NULL,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner_username);
`;

export function dbFile(): string {
  return path.join(config.dataDir, "app.db");
}

function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
    | { version?: number }
    | undefined;
  return typeof row?.version === "number" ? row.version : 0;
}

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const version = currentSchemaVersion(db);
  if (version >= SCHEMA_VERSION) return;
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
}

export function initDatabase(): DatabaseSync {
  if (database) return database;

  fs.mkdirSync(config.dataDir, { recursive: true });
  database = new DatabaseSync(dbFile());
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

export function getDb(): DatabaseSync {
  return database ?? initDatabase();
}

export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
