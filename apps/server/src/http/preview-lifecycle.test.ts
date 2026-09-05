import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { previews } from "../infrastructure/db/schema.ts";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
import {
  bearer,
  createTestApp,
  postDeployToken,
  type TestApp,
} from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";
const OTHER_REPO = "https://github.com/org/other";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
});

async function setup(options?: {
  createDatabase?: (dbName: string) => Promise<void>;
  dropDatabase?: (dbName: string) => Promise<void>;
}) {
  fakePreviewDb = createFakePreviewDb();
  if (options?.createDatabase) {
    fakePreviewDb.createDatabase = options.createDatabase;
  }
  if (options?.dropDatabase) {
    fakePreviewDb.dropDatabase = options.dropDatabase;
  }
  testApp = await createTestApp({ previewDb: fakePreviewDb });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    canonical_repo_id: REPO,
    pr_id: 42,
    slug: "myapp",
    hostname: "pr-42.myapp.preview.example.com",
    ...overrides,
  };
}

function teardownBody(overrides: Record<string, unknown> = {}) {
  return {
    canonical_repo_id: REPO,
    pr_id: 42,
    ...overrides,
  };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/deploy", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function postTeardown(token: string, body: Record<string, unknown>) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/teardown", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/deploy", () => {
  test("rejects invalid slug before SQL", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ slug: "bad_slug!" }),
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_slug" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("rejects invalid pr_id before SQL", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody({ pr_id: 0 }));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_pr_id" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("creates preview database and SQLite row", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      db_name: "prev_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
    });
    expect(fakePreviewDb!.created).toEqual(["prev_myapp_pr42"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row).toMatchObject({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "prev_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
      containerId: null,
    });
  });

  test("deploy token cannot deploy for a different canonical repo", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ canonical_repo_id: OTHER_REPO }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("re-deploy keeps existing identity while retrying CREATE", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const res = await postDeploy(
      deployToken,
      deployBody({ slug: "other", hostname: "ignored.example.com" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: "myapp",
      db_name: "prev_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
    });
    // provisioning always retries CREATE (idempotent in postgres adapter)
    expect(fakePreviewDb!.created).toEqual([
      "prev_myapp_pr42",
      "prev_myapp_pr42",
    ]);
  });

  test("retries createDatabase when stuck in provisioning with no DB", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "prev_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
    });
    expect(fakePreviewDb!.created).toEqual([]);

    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      db_name: "prev_myapp_pr42",
      status: "provisioning",
    });
    expect(fakePreviewDb!.created).toEqual(["prev_myapp_pr42"]);
  });

  test("recreates database after teardown", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    await postTeardown(deployToken, teardownBody());
    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(200);
    expect(fakePreviewDb!.created).toEqual([
      "prev_myapp_pr42",
      "prev_myapp_pr42",
    ]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("provisioning");
  });

  test("marks error when createDatabase fails after SQLite write", async () => {
    const { deployToken } = await setup({
      createDatabase: async () => {
        throw new Error("boom");
      },
    });
    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "preview_db_create_failed" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("error");
  });

  test("retries provision after previous create failure", async () => {
    let failOnce = true;
    const { deployToken } = await setup({
      createDatabase: async (dbName) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("boom");
        }
        fakePreviewDb!.created.push(dbName);
      },
    });
    expect((await postDeploy(deployToken, deployBody())).status).toBe(500);
    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "provisioning" });
    expect(fakePreviewDb!.created).toEqual(["prev_myapp_pr42"]);
  });

  test("parallel first deploys do not 500", async () => {
    const { deployToken } = await setup();
    const body = deployBody();
    const [a, b] = await Promise.all([
      postDeploy(deployToken, body),
      postDeploy(deployToken, body),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(fakePreviewDb!.created.length).toBeGreaterThanOrEqual(1);
    expect(fakePreviewDb!.created.every((n) => n === "prev_myapp_pr42")).toBe(
      true,
    );
  });
});

describe("POST /v1/teardown", () => {
  test("drops database and sets status removed", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["prev_myapp_pr42"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("removed");
  });

  test("accepts body with only repo and pr_id", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const res = await postTeardown(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
  });

  test("is idempotent when already removed", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    await postTeardown(deployToken, teardownBody());
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["prev_myapp_pr42"]);
  });

  test("is idempotent when preview never existed", async () => {
    const { deployToken } = await setup();
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual([]);
  });

  test("rejects invalid pr_id", async () => {
    const { deployToken } = await setup();
    const res = await postTeardown(deployToken, teardownBody({ pr_id: 0 }));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_pr_id" });
    expect(fakePreviewDb!.dropped).toEqual([]);
  });

  test("marks error when dropDatabase fails after removing", async () => {
    const { deployToken } = await setup({
      dropDatabase: async () => {
        throw new Error("boom");
      },
    });
    await postDeploy(deployToken, deployBody());
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "preview_db_drop_failed" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("error");
  });
});
