import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectState, initSchema } from "../src/db.ts";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function sqlitePath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "pb-db-"));
  return join(tmpDir, "state.db");
}

async function tableNames(sql: ReturnType<typeof connectState>): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
}

describe("initSchema", () => {
  test("creates previews, repos, and api_tokens tables", async () => {
    const sql = connectState(sqlitePath());
    try {
      await initSchema(sql);
      expect(await tableNames(sql)).toEqual([
        "api_tokens",
        "previews",
        "repos",
      ]);
    } finally {
      await sql.close();
    }
  });

  test("is idempotent on re-init", async () => {
    const sql = connectState(sqlitePath());
    try {
      await initSchema(sql);
      await initSchema(sql);
      expect(await tableNames(sql)).toEqual([
        "api_tokens",
        "previews",
        "repos",
      ]);
    } finally {
      await sql.close();
    }
  });
});
