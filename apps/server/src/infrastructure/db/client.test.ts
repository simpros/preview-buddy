import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectState } from "./client.ts";
import { repos } from "./schema.ts";
import { runMigrations } from "../../scripts/migrate.ts";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function sqlitePath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pb-db-"));
  return join(tmpDir, "state.db");
}

async function tableNames(sql: ReturnType<typeof connectState>["sql"]) {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
}

describe("connectState", () => {
  test("db handle is schema-aware", async () => {
    const { sql, db } = connectState(sqlitePath());
    try {
      await runMigrations(sql);
      expect(await db.select().from(repos)).toEqual([]);
    } finally {
      await sql.close();
    }
  });
});

describe("runMigrations", () => {
  test("creates previews, repos, and api_tokens tables", async () => {
    const { sql } = connectState(sqlitePath());
    try {
      await runMigrations(sql);
      expect(await tableNames(sql)).toEqual([
        "__drizzle_migrations",
        "api_tokens",
        "previews",
        "repos",
      ]);
    } finally {
      await sql.close();
    }
  });

  test("is idempotent on re-run", async () => {
    const { sql } = connectState(sqlitePath());
    try {
      await runMigrations(sql);
      await runMigrations(sql);
      expect(await tableNames(sql)).toEqual([
        "__drizzle_migrations",
        "api_tokens",
        "previews",
        "repos",
      ]);
    } finally {
      await sql.close();
    }
  });
});
