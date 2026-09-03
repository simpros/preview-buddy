import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { bootstrapAdminToken } from "../auth/bootstrap.ts";
import { connectState } from "../infrastructure/db/client.ts";
import { repos } from "../infrastructure/db/schema.ts";
import { runMigrations } from "../scripts/migrate.ts";
import { createRoutes } from "./routes.ts";
import { bearer, createTestApp, type TestApp } from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";

let testApp: TestApp | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("createRoutes", () => {
  test("GET /healthz returns ok without auth", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/healthz"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("bearer auth", () => {
  test("rejects missing token on /v1/* with 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens"),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("rejects invalid token with 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer("not-a-real-token"),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("admin token lists tokens", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(testApp.adminToken),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].scope).toBe("admin");
    expect(body.tokens[0].token).toBeUndefined();
  });

  test("creates deploy token bound to canonical repo and auto-registers repo", async () => {
    testApp = await createTestApp();
    const createRes = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        method: "POST",
        headers: { ...bearer(testApp.adminToken), "content-type": "application/json" },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          slug: "myapp",
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.scope).toBe("deploy");
    expect(created.canonical_repo_id).toBe(REPO);
    expect(typeof created.token).toBe("string");
    expect(created.token.length).toBeGreaterThan(10);
    expect(created.id).toBeDefined();

    const listRes = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(testApp.adminToken),
      }),
    );
    const listed = await listRes.json();
    const deploy = listed.tokens.find(
      (t: { scope: string }) => t.scope === "deploy",
    );
    expect(deploy).toBeDefined();
    expect(deploy.token).toBeUndefined();
    expect(deploy.canonical_repo_id).toBe(REPO);

    const [repo] = await testApp.db
      .select()
      .from(repos)
      .where(eq(repos.canonicalId, REPO))
      .limit(1);
    expect(repo?.slug).toBe("myapp");
  });

  test("rejects unauthenticated unknown /v1 routes with 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/unknown"),
    );
    expect(res.status).toBe(401);
  });

  test("revokes token via DELETE /v1/admin/tokens/:id", async () => {
    testApp = await createTestApp();
    const createRes = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        method: "POST",
        headers: { ...bearer(testApp.adminToken), "content-type": "application/json" },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          slug: "myapp",
        }),
      }),
    );
    const { token, id } = await createRes.json();

    const deleteRes = await testApp.app.handle(
      new Request(`http://localhost/v1/admin/tokens/${id}`, {
        method: "DELETE",
        headers: bearer(testApp.adminToken),
      }),
    );
    expect(deleteRes.status).toBe(200);

    const useRes = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        headers: bearer(token),
      }),
    );
    expect(useRes.status).toBe(401);
  });

  test("deploy token cannot call admin routes", async () => {
    testApp = await createTestApp();
    const createRes = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        method: "POST",
        headers: { ...bearer(testApp.adminToken), "content-type": "application/json" },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          slug: "myapp",
        }),
      }),
    );
    const { token: deployToken } = await createRes.json();

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(deployToken),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("admin token can reach non-admin /v1 routes", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        headers: bearer(testApp.adminToken),
      }),
    );
    expect(res.status).toBe(501);
  });

  test("deploy token can reach deploy routes", async () => {
    testApp = await createTestApp();
    const createRes = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        method: "POST",
        headers: { ...bearer(testApp.adminToken), "content-type": "application/json" },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          slug: "myapp",
        }),
      }),
    );
    const { token: deployToken } = await createRes.json();

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        headers: bearer(deployToken),
      }),
    );
    expect(res.status).toBe(501);
  });
});

describe("bootstrapAdminToken", () => {
  test("PB_ADMIN_TOKEN bootstrap inserts admin hash idempotently", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pb-bootstrap-"));
    const { sql, db } = connectState(join(tmpDir, "state.db"));
    try {
      await runMigrations(sql);
      await bootstrapAdminToken(db, { adminToken: "configured-admin" });
      await bootstrapAdminToken(db, { adminToken: "configured-admin" });

      const generated = await bootstrapAdminToken(db, {});
      expect(generated).toBeNull();

      const app = createRoutes({ db });
      const res = await app.handle(
        new Request("http://localhost/v1/admin/tokens", {
          headers: bearer("configured-admin"),
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      await sql.close();
    }
  });

  test("auto-generates admin token when none configured", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pb-bootstrap-"));
    const { sql, db } = connectState(join(tmpDir, "state.db"));
    try {
      await runMigrations(sql);
      const generated = await bootstrapAdminToken(db, {});
      expect(generated).toBeString();
      expect(generated!.startsWith("pb_")).toBe(true);

      const again = await bootstrapAdminToken(db, {});
      expect(again).toBeNull();
    } finally {
      await sql.close();
    }
  });
});
