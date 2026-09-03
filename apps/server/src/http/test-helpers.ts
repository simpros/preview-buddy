import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapAdminToken } from "../auth/bootstrap.ts";
import { connectState, type StateDb } from "../infrastructure/db/client.ts";
import { runMigrations } from "../scripts/migrate.ts";
import { createRoutes } from "./routes.ts";

export type TestApp = {
  app: ReturnType<typeof createRoutes>;
  db: StateDb;
  adminToken: string;
  cleanup: () => Promise<void>;
};

export async function createTestApp(
  adminToken = "test-admin-token",
): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), "pb-auth-"));
  const dbPath = join(dir, "state.db");
  const { sql, db } = connectState(dbPath);
  await runMigrations(sql);
  await bootstrapAdminToken(db, { adminToken });

  return {
    app: createRoutes({ db }),
    db,
    adminToken,
    cleanup: async () => {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}
