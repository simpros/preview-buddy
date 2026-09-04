import { SQL } from "bun";
import type { PreviewDb } from "./port.ts";

const SAFE_DB_NAME = /^prev_[a-z][a-z0-9]*_pr[1-9][0-9]*$/;
/** Unquoted Postgres identifiers fold to lowercase — require lowercase roles. */
const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

export type PostgresPreviewDbOptions = {
  url: string;
  previewRole: string;
};

function assertSafeDbName(dbName: string): void {
  if (!SAFE_DB_NAME.test(dbName)) {
    throw new Error(`refusing unsafe preview database name: ${dbName}`);
  }
}

function assertSafeRole(role: string): void {
  if (!SAFE_ROLE.test(role)) {
    throw new Error(`refusing unsafe preview role name: ${role}`);
  }
}

function isDuplicateDatabase(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  if (code === "42P04") return true;
  const message = "message" in err ? String(err.message) : String(err);
  return /already exists/i.test(message);
}

export function createPostgresPreviewDb(
  options: PostgresPreviewDbOptions,
): PreviewDb {
  assertSafeRole(options.previewRole);
  const sql = new SQL(options.url);
  const previewRole = options.previewRole;

  return {
    async createDatabase(dbName) {
      assertSafeDbName(dbName);
      const existing = await sql`
        SELECT 1 AS ok FROM pg_database WHERE datname = ${dbName} LIMIT 1
      `;
      if (existing.length > 0) return;
      // Identifiers validated above; Bun.sql cannot parameterize DDL identifiers.
      try {
        await sql.unsafe(
          `CREATE DATABASE ${dbName} OWNER ${previewRole}`,
        );
      } catch (err) {
        // Concurrent deploy: another request created the DB between SELECT and CREATE.
        if (isDuplicateDatabase(err)) return;
        throw err;
      }
    },

    async dropDatabase(dbName) {
      assertSafeDbName(dbName);
      await sql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${dbName} AND pid <> pg_backend_pid()
      `;
      await sql.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    },
  };
}
