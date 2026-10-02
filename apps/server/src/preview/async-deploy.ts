import { SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
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
import type {
  TelemetryDeployHook,
  TelemetryDeployOutcome,
} from "../telemetry/contract.ts";
import { runWithTraceContext } from "../telemetry/trace-context.ts";
import { TRACER_NAME } from "../telemetry/tracer-name.ts";

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
  const startedAt = Date.now();
  const phases = createPhaseCollector();
  const tracer = trace.getTracer(TRACER_NAME);
  await tracer.startActiveSpan(
    "preview.deploy",
    {
      // Detached from the accepting request span: its own root trace,
      // correlated by sprout.* attributes rather than the trace id.
      root: true,
      attributes: {
        "sprout.repo": input.repo,
        "sprout.pr": input.prId,
        "sprout.slug": input.slug,
        "sprout.plan": plan,
      },
    },
    async (span) => {
      // Bound once where the context is still valid: past this point the
      // OTel manager no longer carries it across awaits (see trace-context).
      const { outcome, caught } = await runWithTraceContext(
        context.active(),
        () => attemptDeploy(deps, input, plan, { startedAt, phases }),
      );
      applyDeploySpanStatus(span, outcome, caught);
      span.end();
    },
  );
}

type AttemptClock = {
  startedAt: number;
  phases: ReturnType<typeof createPhaseCollector>;
};

async function attemptDeploy(
  deps: AsyncDeployDeps,
  input: ProvisionInput,
  plan: BringUpPlan,
  clock: AttemptClock,
): Promise<{ outcome: TelemetryDeployOutcome | null; caught: unknown }> {
  const key = previewKey(input.repo, input.prId);
  let caught: unknown;
  try {
    await provisionPreview(
      { ...deps, phaseTimer: clock.phases.timer },
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
  }
  const outcome = await captureDeployOutcome(deps.db, {
    repo: input.repo,
    prId: input.prId,
    plan,
    startedAt: clock.startedAt,
    phaseMs: clock.phases.phaseMs,
  });
  inFlightDeploys.delete(key);
  if (outcome) {
    // exportEvent never rejects, so there is nothing to catch here.
    deps.telemetry.reportDeployOutcome(outcome);
  }
  return { outcome, caught };
}

function applyDeploySpanStatus(
  span: Span,
  outcome: TelemetryDeployOutcome | null,
  caught: unknown,
): void {
  if (outcome) {
    span.setAttribute("sprout.status", outcome.outcome);
    if (outcome.outcome === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(
        new Error(outcome.failureClass ?? "deploy_failed"),
      );
    }
    return;
  }
  span.setAttribute("sprout.status", "unknown");
  if (caught !== undefined) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.recordException(
      caught instanceof Error ? caught : new Error(String(caught)),
    );
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
