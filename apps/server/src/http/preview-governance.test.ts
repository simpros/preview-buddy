import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { bindPreviewDataVolumes } from "../preview/data-volumes.ts";
import { removePreview } from "../preview/lifecycle.ts";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
import {
  bindTestPreviewApp,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
});

async function setupGovernance(governance: {
  previewTtlMs: number | null;
  previewIdleMs: number | null;
  maxPreviews: number | null;
  maxPreviewsPerRepo: number | null;
  previewMaxDbConnections: number | null;
  postgresMaxConnections: number | null;
}) {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
  });
  testApp = await createTestApp({
    previewDb: fakePreviewDb,
    docker: fakeDocker,
    governance,
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

function teardownDeps() {
  return {
    db: testApp!.db,
    previewDb: testApp!.previewDb,
    app: bindTestPreviewApp(testApp!.docker),
    dataVolumes: bindPreviewDataVolumes(testApp!.docker),
  };
}

async function row() {
  const [found] = await testApp!.db
    .select()
    .from(previews)
    .where(and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)))
    .limit(1);
  return found;
}

describe("preview governance lifecycle", () => {
  test("derives expires_at from the gateway ttl on the read surface", async () => {
    const { deployToken } = await setupGovernance({
      previewTtlMs: 7 * 86400_000,
      previewIdleMs: null,
      maxPreviews: null,
      maxPreviewsPerRepo: null,
      previewMaxDbConnections: null,
      postgresMaxConnections: null,
    });
    const res = await postDeployAndSettle(testApp!, deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    const snap = res.body as {
      last_activity_at: string;
      expires_at: string | null;
    };
    expect(typeof snap.last_activity_at).toBe("string");
    expect(snap.expires_at).toBe(
      new Date(Date.parse(snap.last_activity_at) + 7 * 86400_000).toISOString(),
    );
  });

  test("a sweep plan built before a refresh is stale", async () => {
    const { deployToken } = await setupGovernance({
      previewTtlMs: 7 * 86400_000,
      previewIdleMs: null,
      maxPreviews: null,
      maxPreviewsPerRepo: null,
      previewMaxDbConnections: null,
      postgresMaxConnections: null,
    });
    const first = await postDeployAndSettle(testApp!, deployToken, deployBody());
    expect(first.settleStatus).toBe(200);
    const before = await row();
    const stalePlan = {
      repo: REPO,
      prId: 42,
      expectedDbName: before!.dbName,
      expectedCreatedAt: before!.createdAt,
      expectedLastActivityAt: before!.lastActivityAt ?? null,
    };

    const second = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody(),
    );
    expect(second.settleStatus).toBe(200);
    const after = await row();
    expect(after!.lastActivityAt).not.toBe(before!.lastActivityAt);

    const dropped = await removePreview(teardownDeps(), {
      ...stalePlan,
      expiryReason: "sweep:ttl-expired",
    });
    expect(dropped).toEqual({ ok: true, value: false });
    expect((await row())!.status).toBe("running");
  });

  test("re-provisioning a removed row clears the tombstone reason", async () => {
    const { deployToken } = await setupGovernance({
      previewTtlMs: 7 * 86400_000,
      previewIdleMs: null,
      maxPreviews: null,
      maxPreviewsPerRepo: null,
      previewMaxDbConnections: null,
      postgresMaxConnections: null,
    });
    const first = await postDeployAndSettle(testApp!, deployToken, deployBody());
    expect(first.settleStatus).toBe(200);
    const live = await row();

    const removed = await removePreview(teardownDeps(), {
      repo: REPO,
      prId: 42,
      expectedDbName: live!.dbName,
      expectedCreatedAt: live!.createdAt,
      expectedLastActivityAt: live!.lastActivityAt ?? null,
      expiryReason: "sweep:ttl-expired",
    });
    expect(removed).toEqual({ ok: true, value: true });
    expect((await row())!.expiryReason).toBe("sweep:ttl-expired");

    const redeploy = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody(),
    );
    expect(redeploy.settleStatus).toBe(200);
    expect((await row())!.expiryReason).toBeNull();
    expect(
      (redeploy.body as { expiry_reason: string | null }).expiry_reason,
    ).toBeNull();
  });
});
