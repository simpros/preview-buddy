import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { SQL } from "bun";
import path from "node:path";
import { connectState, createDrizzle } from "../infrastructure/db/client.ts";

const migrationsFolder =
  process.env.MIGRATIONS_DIR ??
  path.join(import.meta.dir, "../../drizzle");

export async function runMigrations(sql?: SQL): Promise<void> {
  if (sql) {
    const db = createDrizzle(sql);
    await migrate.sqlite(db, { migrationsFolder });
    return;
  }

  const { sql: client, db } = connectState();
  try {
    await migrate.sqlite(db, { migrationsFolder });
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log("Database migrations complete.");
}
