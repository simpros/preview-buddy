import { randomBytes } from "node:crypto";
import { SQL } from "bun";

const APP_ROLE = "preview_buddy_app";

export type AdminDb = SQL;

export function databaseName(prefix: string, prId: number): string {
  const id = String(prId);
  if (!/^\d+$/.test(id)) {
    throw new Error("prId must be digits only");
  }
  const name = `${prefix}${id}`;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid database identifier: ${name}`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function connectAdmin(databaseUrl: string): AdminDb {
  return new SQL(databaseUrl);
}

export async function ensureStateTable(sql: AdminDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS pb_state (
      pr_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pr_id, repo)
    )
  `;
}

export async function recordPreviewState(
  sql: AdminDb,
  prId: number,
  repo: string,
): Promise<void> {
  await ensureStateTable(sql);
  await sql`
    INSERT INTO pb_state (pr_id, repo) VALUES (${prId}, ${repo})
    ON CONFLICT (pr_id, repo) DO NOTHING
  `;
}

export async function clearPreviewState(
  sql: AdminDb,
  prId: number,
  repo: string,
): Promise<void> {
  await sql`DELETE FROM pb_state WHERE pr_id = ${prId} AND repo = ${repo}`;
}

export async function createDatabase(
  sql: AdminDb,
  prefix: string,
  prId: number,
): Promise<string> {
  const name = databaseName(prefix, prId);
  await sql.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
  return name;
}

export async function dropDatabase(
  sql: AdminDb,
  prefix: string,
  prId: number,
): Promise<void> {
  const name = databaseName(prefix, prId);
  await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

export async function ensureRole(
  sql: AdminDb,
): Promise<{ role: string; password: string; created: boolean }> {
  const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}`;

  if (rows.length > 0) {
    return { role: APP_ROLE, password: "", created: false };
  }

  const password = randomBytes(24).toString("base64url");
  await sql.unsafe(
    `CREATE ROLE ${quoteIdent(APP_ROLE)} LOGIN PASSWORD $1`,
    [password],
  );
  return { role: APP_ROLE, password, created: true };
}

export async function grantDatabaseAccess(
  sql: AdminDb,
  dbName: string,
): Promise<void> {
  await sql.unsafe(
    `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(APP_ROLE)}`,
  );
}

export async function listDatabases(
  sql: AdminDb,
  prefix: string,
): Promise<string[]> {
  const pattern = `${prefix}%`;
  const rows = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE ${pattern}
  `;
  return rows.map((row) => row.datname);
}

export function prIdFromDatabaseName(
  prefix: string,
  datname: string,
): number | null {
  if (!datname.startsWith(prefix)) return null;
  const suffix = datname.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}
