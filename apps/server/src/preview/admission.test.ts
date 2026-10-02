import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../http/test-helpers.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { checkDeployAdmission } from "./admission.ts";
import type { GovernanceConfig } from "@sprout/preview-env";

const REPO = "https://github.com/acme/widgets";

const overBudget: GovernanceConfig = {
  previewTtlMs: null,
  previewIdleMs: null,
  maxPreviews: null,
  maxPreviewsPerRepo: null,
  previewMaxDbConnections: 12,
  postgresMaxConnections: 20,
};

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
        "1 active previews + 1 x 12 per preview)",
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
