import { SQL } from "bun";

export type StateDb = SQL;

const DEFAULT_SQLITE_PATH = "preview-buddy.db";

export function connectState(path: string = DEFAULT_SQLITE_PATH): StateDb {
  return new SQL(`sqlite://${path}`);
}

export async function initSchema(sql: StateDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS previews (
      canonical_repo_id TEXT NOT NULL,
      pr_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      db_name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      app_image TEXT,
      container_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      seeded_at TEXT,
      PRIMARY KEY (canonical_repo_id, pr_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS repos (
      canonical_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      canonical_repo_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    )
  `;
}
