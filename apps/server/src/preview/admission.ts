import { ne } from "drizzle-orm";
import {
  connectionBudgetDetail,
  connectionProjection,
  governanceStatus,
  previewLimitDetail,
  resolveEffectiveGovernanceMs,
  type GovernanceConfig,
  type GovernanceManifest,
  type GovernanceStatus,
} from "@sprout/preview-env";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import type { Result } from "./result.ts";

export type DeployAdmission = { ttlMs: number | null; idleMs: number | null };

/**
 * Single admission gate for deploy: per-repo/total caps plus the connection
 * budget, over one load of the live rows. Refreshing an existing preview
 * never counts against the caps. Returns the effective governance.
 */
export async function checkDeployAdmission(
  db: StateDb,
  input: { repo: string; prId: number },
  gov: GovernanceConfig | undefined,
  manifest: GovernanceManifest | undefined,
): Promise<Result<DeployAdmission>> {
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
  const status: GovernanceStatus = governanceStatus(rows, gov);

  if (isNew) {
    const perRepo = gov?.maxPreviewsPerRepo ?? null;
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
    const total = gov?.maxPreviews ?? null;
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
  }

  const perPreview = gov?.previewMaxDbConnections ?? null;
  const ceiling = gov?.postgresMaxConnections ?? null;
  if (perPreview !== null && ceiling !== null) {
    const budget = connectionProjection({
      activePreviews: isNew ? status.total : status.total - 1,
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

  return {
    ok: true,
    value: resolveEffectiveGovernanceMs(manifest, gov),
  };
}
