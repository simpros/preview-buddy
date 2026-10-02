import type { Result } from "./result.ts";
import { parseBringUpPlan } from "./bring-up.ts";
import {
  claimDeployIntent,
  getPreviewRow,
  markPreviewFailed,
  provisionPreview,
  withPreviewLock,
  type LifecycleDeps,
  type PreviewRow,
  type ProvisionInput,
} from "./lifecycle.ts";
import {
  parsePreviewStatus,
} from "./snapshot.ts";
import { createPhaseCollector } from "./timing.ts";
import type { BringUpPlan } from "./types.ts";
import type {
  TelemetryDeployHook,
  TelemetryDeployOutcome,
} from "../telemetry/reporter.ts";

const inFlightDeploys = new Map<string, { slug: string; dbName: string | null }>();

function previewKey(repo: string, prId: number): string {
  return `${repo}\0${prId}`;
}

export async function acceptAsyncDeploy(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<{ row: PreviewRow; launch: boolean }>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const requestedDbName = input.plan.dbName;
    const key = previewKey(input.repo, input.prId);
    const pending = inFlightDeploys.get(key);

    if (pending) {
      if (
        pending.slug === input.slug &&
        pending.dbName === requestedDbName
      ) {
        const row = await getPreviewRow(deps.db, input.repo, input.prId);
        if (row && row.status !== "removed") {
          return {
            ok: true,
            value: {
              row,
              launch: false,
            },
          };
        }
      }
      return {
        ok: false,
        status: 409,
        error: "preview_deploy_in_progress",
      };
    }

    const claimed = await claimDeployIntent(deps, input);
    if (!claimed.ok) return claimed;

    inFlightDeploys.set(key, {
      slug: input.slug,
      dbName: requestedDbName,
    });
    return { ok: true, value: { row: claimed.value, launch: true } };
  });
}

export type AsyncDeployDeps = LifecycleDeps & {
  telemetry?: TelemetryDeployHook;
};

export async function runAsyncDeploy(
  deps: AsyncDeployDeps,
  input: ProvisionInput,
): Promise<void> {
  const key = previewKey(input.repo, input.prId);
  const startedAt = Date.now();
  const phases = createPhaseCollector();
  // The stored bring-up plan and the telemetry plan share one vocabulary,
  // so the preview parser feeds the deploy report with no telemetry import.
  let plan: BringUpPlan = "full_replace";
  try {
    const intent = await getPreviewRow(deps.db, input.repo, input.prId);
    plan = parseBringUpPlan(intent?.bringUpPlan ?? null);
  } catch {
    // The stored plan is advisory; a lost row read keeps the default.
  }
  try {
    await provisionPreview({ ...deps, phaseTimer: phases.timer }, input);
  } catch (err) {
    console.warn("provision:background_failed", err);
    try {
      await withPreviewLock(input.repo, input.prId, async () => {
        const row = await getPreviewRow(deps.db, input.repo, input.prId);
        if (!row || row.status === "removing" || row.status === "removed") {
          return;
        }
        await markPreviewFailed(
          deps.db,
          input.repo,
          input.prId,
          "preview_app_deploy_failed",
        );
      });
    } catch {
    }
  } finally {
    // The terminal row is read while the in-flight marker still blocks a
    // successor deploy for this key, so the event describes this deploy and
    // never the next one. Only the fire-and-forget export leaves the lock.
    const telemetry = deps.telemetry;
    let outcome: TelemetryDeployOutcome | undefined;
    if (telemetry) {
      try {
        const row = await getPreviewRow(deps.db, input.repo, input.prId);
        const failed = row?.status !== "running";
        const base = {
          plan,
          seeded: row?.seededAt != null,
          durationMs: Date.now() - startedAt,
          phaseMs: phases.phaseMs,
        };
        outcome = failed
          ? {
            ...base,
            outcome: "failed" as const,
            failureClass: row?.lastError ?? null,
            failureFamily: row?.failureFamily ?? null,
          }
          : { ...base, outcome: "running" as const };
      } catch {
        // Telemetry must never change a deploy outcome.
      }
    }
    inFlightDeploys.delete(key);
    if (telemetry && outcome) telemetry.reportDeployOutcome(outcome);
  }
}

export function gateReadablePreviewRow(
  row: PreviewRow | null,
): Result<PreviewRow> {
  if (!row || row.status === "removed") {
    return { ok: false, status: 404, error: "preview_not_found" };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  if (status.value === "removing") {
    return {
      ok: false,
      status: 409,
      error: "preview_teardown_in_progress",
    };
  }

  return { ok: true, value: row };
}
