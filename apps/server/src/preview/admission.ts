import { ne } from "drizzle-orm";
import {
  type EffectiveGovernanceMs,
  type GovernanceConfig,
  type GovernanceManifest,
} from "@sprout/preview-env";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  evaluateGovernance,
  governanceStatus,
  resolveEffectiveGovernanceMs,
  violationMessage,
  type GovernanceStatus,
} from "./governance.ts";
import type { Result } from "./result.ts";

/**
 * Single admission gate for deploy: per-repo/total caps plus the connection
 * budget, over one load of the live rows. Refreshing an existing preview is
 * exempt from caps and budget alike: it holds no new slot, and rejecting it
 * could block the redeploy that would reduce connections. Returns the
 * effective governance.
 *
 * Caps are best-effort under concurrent submits: the check runs before the
 * row insert under the per-preview lock, so two simultaneous deploys for new
 * targets can both pass when one slot remains. Exact enforcement would need
 * admission serialized against the insert; the overshoot is accepted to keep
 * deploys concurrent.
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
    const violation = evaluateGovernance(gov, status, { repo: input.repo })[0];
    if (violation !== undefined) {
      if (violation.kind === "connection-budget") {
        return {
          ok: false,
          status: 429,
          error: "preview_connection_budget_exceeded",
          detail: violationMessage(violation),
        };
      }
      return {
        ok: false,
        status: 429,
        error: "preview_limit_reached",
        detail: violationMessage(violation),
      };
    }
  }

  return {
    ok: true,
    value: resolveEffectiveGovernanceMs(manifest, gov),
  };
}
