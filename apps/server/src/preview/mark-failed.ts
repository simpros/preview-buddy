import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { and, eq } from "drizzle-orm";
import { utcIsoNow } from "./row.ts";
import type {
  BringUpPlan,
  PreviewFailureCode,
  PreviewFailureFamily,
} from "./types.ts";

/** Must run under withPreviewLock; skips removing/removed rows. */
export async function markPreviewFailed(
  db: StateDb,
  repo: string,
  prId: number,
  error: PreviewFailureCode,
  detail?: string,
): Promise<void> {
  await db
    .update(previews)
    .set({
      status: "failed",
      containerId: null,
      lastError: error,
      lastErrorDetail: detail ?? null,
      failureFamily: null,
      bringUpPlan: null,
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

export type StickyPreviewFailure = {
  error: PreviewFailureCode;
  family: PreviewFailureFamily;
  detail?: string | null;
  seedLog?: string | null;
};

function recoveryPlanFor(family: PreviewFailureFamily): BringUpPlan {
  switch (family) {
    case "seed_incomplete":
      return "seed_resume";
    case "post_healthy":
      return "sync_close";
  }
}

export async function markStickyPreviewFailed(
  db: StateDb,
  repo: string,
  prId: number,
  failure: StickyPreviewFailure,
): Promise<void> {
  await db
    .update(previews)
    .set({
      status: "failed",
      lastError: failure.error,
      lastErrorDetail: failure.detail ?? null,
      failureFamily: failure.family,
      bringUpPlan: recoveryPlanFor(failure.family),
      ...(failure.seedLog !== undefined
        ? { seedLog: failure.seedLog === "" ? null : failure.seedLog }
        : {}),
      updatedAt: utcIsoNow(),
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}
