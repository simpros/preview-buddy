import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../http/test-helpers.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { checkDeployAdmission } from "./admission.ts";
import { governanceConfig } from "./governance-fixtures.ts";

const REPO = "https://github.com/acme/widgets";

const overBudget = governanceConfig({
  connectionBudget: { perPreview: 12, ceiling: 20 },
});

describe("checkDeployAdmission connection budget", () => {
  let testDb: TestDb | undefined;

  afterEach(async () => {
    await testDb?.cleanup();
    testDb = undefined;
  });

  async function livePreviews(...prIds: number[]): Promise<void> {
    testDb = await createTestDb();
    for (const prId of prIds) {
      await testDb.db.insert(previews).values({
        canonicalRepoId: REPO,
        prId,
        slug: "widgets",
        hostname: `pr-${prId}.example.com`,
        status: "running",
      });
    }
  }

  test("rejects a new preview over the ceiling with a consistent detail", async () => {
    await livePreviews(1);
    const result = await checkDeployAdmission(
      testDb!.db,
      { repo: REPO, prId: 2 },
      overBudget,
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: "preview_connection_budget_exceeded",
      detail:
        "preview connection budget exceeded (projected 24 > ceiling 20; " +
        "2 previews x 12 per preview)",
    });
  });

  test("a refresh is exempt even when the instance is over budget", async () => {
    await livePreviews(1, 2);
    const result = await checkDeployAdmission(
      testDb!.db,
      { repo: REPO, prId: 1 },
      overBudget,
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      value: { ttlMs: null, idleMs: null },
    });
  });
});

describe("checkDeployAdmission caps", () => {
  let testDb: TestDb | undefined;

  afterEach(async () => {
    await testDb?.cleanup();
    testDb = undefined;
  });

  async function livePreview(repo: string, prId: number): Promise<void> {
    testDb = await createTestDb();
    await testDb.db.insert(previews).values({
      canonicalRepoId: repo,
      prId,
      slug: "widgets",
      hostname: `pr-${prId}.example.com`,
      status: "running",
    });
  }

  test("rejects a new preview at the per-repo cap", async () => {
    await livePreview(REPO, 1);
    const result = await checkDeployAdmission(
      testDb!.db,
      { repo: REPO, prId: 2 },
      governanceConfig({ maxPreviewsPerRepo: 1 }),
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: "preview_limit_reached",
      detail: "SPROUT_MAX_PREVIEWS_PER_REPO limit reached (limit 1, current 1)",
    });
  });

  test("rejects a new preview at the total cap", async () => {
    await livePreview(REPO, 1);
    const result = await checkDeployAdmission(
      testDb!.db,
      { repo: REPO, prId: 2 },
      governanceConfig({ maxPreviews: 1 }),
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: "preview_limit_reached",
      detail: "SPROUT_MAX_PREVIEWS limit reached (limit 1, current 1)",
    });
  });

  test("a refresh is exempt from caps", async () => {
    await livePreview(REPO, 1);
    const result = await checkDeployAdmission(
      testDb!.db,
      { repo: REPO, prId: 1 },
      governanceConfig({ maxPreviews: 1, maxPreviewsPerRepo: 1 }),
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      value: { ttlMs: null, idleMs: null },
    });
  });
});
