import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAdminToken } from "../auth/store.ts";
import { connectState, type StateDb } from "../infrastructure/db/client.ts";
import { createFakePreviewDb } from "../preview-db/fake.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import { runMigrations } from "../scripts/migrate.ts";
import { createRoutes } from "./routes.ts";

export type TestDb = {
  db: StateDb;
  cleanup: () => Promise<void>;
};

export type TestApp = {
  app: ReturnType<typeof createRoutes>;
  db: StateDb;
  adminToken: string;
  previewDb: PreviewDb;
  cleanup: () => Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "pb-auth-"));
  const { sql, db } = connectState(join(dir, "state.db"));
  await runMigrations(sql);
  return {
    db,
    cleanup: async () => {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createTestApp(
  options: { adminToken?: string; previewDb?: PreviewDb } | string = {},
): Promise<TestApp> {
  const opts =
    typeof options === "string" ? { adminToken: options } : options;
  const adminToken = opts.adminToken ?? "test-admin-token";
  const previewDb = opts.previewDb ?? createFakePreviewDb();
  const { db, cleanup } = await createTestDb();
  await ensureAdminToken(db, adminToken);
  return {
    app: createRoutes({ db, previewDb }),
    db,
    adminToken,
    previewDb,
    cleanup,
  };
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export async function postDeployToken(
  app: TestApp,
  body: { canonical_repo_id: string; slug: string },
) {
  const res = await app.app.handle(
    new Request("http://localhost/v1/admin/tokens", {
      method: "POST",
      headers: {
        ...bearer(app.adminToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}
