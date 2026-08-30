import { randomBytes } from "node:crypto";
import pg from "pg";

const APP_ROLE = "preview_buddy_app";

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

export async function ensureStateTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pb_state (
      pr_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pr_id, repo)
    )
  `);
}

export async function recordPreviewState(
  client: pg.Client,
  prId: number,
  repo: string,
): Promise<void> {
  await ensureStateTable(client);
  await client.query(
    `INSERT INTO pb_state (pr_id, repo) VALUES ($1, $2)
     ON CONFLICT (pr_id, repo) DO NOTHING`,
    [prId, repo],
  );
}

export async function clearPreviewState(
  client: pg.Client,
  prId: number,
  repo: string,
): Promise<void> {
  await client.query("DELETE FROM pb_state WHERE pr_id = $1 AND repo = $2", [
    prId,
    repo,
  ]);
}

export async function createDatabase(
  client: pg.Client,
  prefix: string,
  prId: number,
): Promise<string> {
  const name = databaseName(prefix, prId);
  await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
  return name;
}

export async function dropDatabase(
  client: pg.Client,
  prefix: string,
  prId: number,
): Promise<void> {
  const name = databaseName(prefix, prId);
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

export async function ensureRole(
  client: pg.Client,
): Promise<{ role: string; password: string; created: boolean }> {
  const { rows } = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [APP_ROLE],
  );

  if (rows.length > 0) {
    return { role: APP_ROLE, password: "", created: false };
  }

  const password = randomBytes(24).toString("base64url");
  await client.query(
    `CREATE ROLE ${quoteIdent(APP_ROLE)} LOGIN PASSWORD $1`,
    [password],
  );
  return { role: APP_ROLE, password, created: true };
}

export async function grantDatabaseAccess(
  client: pg.Client,
  dbName: string,
): Promise<void> {
  await client.query(
    `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(APP_ROLE)}`,
  );
}

export async function listDatabases(
  client: pg.Client,
  prefix: string,
): Promise<string[]> {
  const { rows } = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE $1",
    [`${prefix}%`],
  );
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

export async function connectAdmin(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}
