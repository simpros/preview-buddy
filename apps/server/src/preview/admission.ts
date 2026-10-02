import { ne } from "drizzle-orm";
import {
  connectionBudgetDetail,
  connectionProjection,
  governanceStatus,
  previewLimitDetail,
  resolveEffectiveGovernanceMs,
  type EffectiveGovernanceMs,
  type GovernanceConfig,
  type GovernanceManifest,
  type GovernanceStatus,
} from "@sprout/preview-env";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import type { Result } from "./result.ts";

/**
 * Single admission gate for deploy: per-repo/total caps plus the connection
 * budget, over one load of the live rows. Refreshing an existing preview is
 * exempt from caps and budget alike: it holds no new slot, and rejecting it
 * could block the redeploy that would reduce connections. Returns the
 * effective governance.
 */
export async function checkDeployAdmission(
  db: StateDb,
  input: { repo: string; prId: number },
  gov: GovernanceConfig,
  manifest: GovernanceManifest | undefined,
): Promise<Result<EffectiveGovernanceMs>> {
  const rows = await db
    .select({
      canonicalRepoId: previews.canonicalRepoId,
      prId: previews.prId,
    })
    .from(previews)
    .where(ne(previews.status, "removed"));
  const isNew = !rows.some(
    (row) => row.canonicalRepoId === input.repo && row.prId === input.prId,
  );
  const status: GovernanceStatus = governanceStatus(rows);

  if (isNew) {
    const perRepo = gov.maxPreviewsPerRepo;
    if (perRepo !== null) {
      const count = status.byRepo.get(input.repo) ?? 0;
      if (count >= perRepo) {
        return {
          ok: false,
          status: 429,
          error: "preview_limit_reached",
          detail: previewLimitDetail({
            cap: "SPROUT_MAX_PREVIEWS_PER_REPO",
            value: perRepo,
            count,
          }),
        };
      }
    }
    const total = gov.maxPreviews;
    if (total !== null && status.total >= total) {
      return {
        ok: false,
        status: 429,
        error: "preview_limit_reached",
        detail: previewLimitDetail({
          cap: "SPROUT_MAX_PREVIEWS",
          value: total,
          count: status.total,
        }),
      };
    }
    const perPreview = gov.previewMaxDbConnections;
    const ceiling = gov.postgresMaxConnections;
    if (perPreview !== null && ceiling !== null) {
      const budget = connectionProjection({
        activePreviews: status.total,
        perPreview,
        ceiling,
      });
      if (budget.over && budget.projected !== null) {
        return {
          ok: false,
          status: 429,
          error: "preview_connection_budget_exceeded",
          detail: connectionBudgetDetail({
            projected: budget.projected,
            ceiling,
            perPreview,
            active: status.total,
          }),
        };
      }
    }
  }

  return {
    ok: true,
    value: resolveEffectiveGovernanceMs(manifest, gov),
  };
}
