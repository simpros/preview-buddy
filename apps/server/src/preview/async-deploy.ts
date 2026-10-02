import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Result } from "./result.ts";
import { captureDeployOutcome } from "./deploy-outcome.ts";
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
import type { TelemetryDeployHook } from "../telemetry/contract.ts";
import { TRACER_NAME } from "../telemetry/traces.ts";

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
  telemetry: TelemetryDeployHook;
};

export async function runAsyncDeploy(
  deps: AsyncDeployDeps,
  input: ProvisionInput,
  plan: BringUpPlan,
): Promise<void> {
  const key = previewKey(input.repo, input.prId);
  const startedAt = Date.now();
  const phases = createPhaseCollector();
  const tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  await tracer.startActiveSpan(
    "preview.deploy",
    {
      attributes: {
        "sprout.repo": input.repo,
        "sprout.pr": input.prId,
        "sprout.slug": input.slug,
        "sprout.plan": plan,
      },
    },
    async (span) => {
      const traceContext = trace.setSpan(context.active(), span);
      let caught: unknown;
      try {
        await provisionPreview(
          { ...deps, phaseTimer: phases.timer, tracer, traceContext },
          input,
        );
      } catch (err) {
        caught = err;
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
        const outcome = await captureDeployOutcome(deps.db, {
          repo: input.repo,
          prId: input.prId,
          plan,
          startedAt,
          phaseMs: phases.phaseMs,
        });
        inFlightDeploys.delete(key);
        if (outcome) {
          span.setAttribute("sprout.status", outcome.outcome);
          if (outcome.outcome === "failed") {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.recordException(
              new Error(outcome.failureClass ?? "deploy_failed"),
            );
          }
          // exportEvent never rejects, so there is nothing to catch here.
          deps.telemetry.reportDeployOutcome(outcome);
        } else {
          span.setAttribute("sprout.status", "unknown");
          if (caught !== undefined) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.recordException(caught as Error);
          }
        }
        span.end();
      }
    },
  );
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
