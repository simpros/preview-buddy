import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import path from "node:path";
import { resolveStateDbPath } from "../infrastructure/db/client.ts";

const migrationsFolder =
  process.env.MIGRATIONS_DIR ??
  path.join(import.meta.dir, "../../drizzle");

export async function runMigrations(sql?: SQL): Promise<void> {
  const client = sql ?? new SQL(`sqlite://${resolveStateDbPath()}`);
  const ownsClient = sql === undefined;
  const db = drizzle.sqlite({ client });

  try {
    await migrate.sqlite(db, { migrationsFolder });
  } finally {
    if (ownsClient) {
      await client.close();
    }
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log("Database migrations complete.");
}
