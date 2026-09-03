import { SQL } from "bun";
import type { PreviewDb } from "./port.ts";

const SAFE_DB_NAME = /^prev_[a-z][a-z0-9]*_pr[1-9][0-9]*$/;
const SAFE_ROLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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

export function createPostgresPreviewDb(
  options: PostgresPreviewDbOptions,
): PreviewDb {
  const sql = new SQL(options.url);
  const previewRole = options.previewRole;
  assertSafeRole(previewRole);

  return {
    async createDatabase(dbName) {
      assertSafeDbName(dbName);
      const existing = await sql`
        SELECT 1 AS ok FROM pg_database WHERE datname = ${dbName} LIMIT 1
      `;
      if (existing.length > 0) return;
      // Identifiers validated above; Bun.sql cannot parameterize DDL identifiers.
      await sql.unsafe(
        `CREATE DATABASE ${dbName} OWNER ${previewRole}`,
      );
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
