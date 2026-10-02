import {
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { TRACER_NAME } from "../telemetry/traces.ts";
import type {
  PhaseTimer,
  PreviewPhase,
  PreviewPhaseMs,
} from "./types.ts";

/** Runs fn, records wall time, and wraps it in a preview.<phase> child span. */
export async function timed<T>(
  deps: { phaseTimer?: PhaseTimer; tracer?: Tracer; traceContext?: Context },
  phase: PreviewPhase,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  const start = Date.now();
  const run = async (span: Span): Promise<T> => {
    try {
      const result = await fn();
      if (
        result !== null &&
        typeof result === "object" &&
        "ok" in result &&
        (result as { ok: unknown }).ok === false
      ) {
        const error = (result as { error?: unknown }).error;
        const message =
          typeof error === "string" ? error : `preview_${phase}_failed`;
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.recordException(new Error(message));
      }
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err as Error);
      throw err;
    } finally {
      if (deps.phaseTimer) {
        deps.phaseTimer.record(phase, Date.now() - start);
      }
      span.end();
    }
  };
  if (deps.traceContext) {
    return tracer.startActiveSpan(`preview.${phase}`, {}, deps.traceContext, run);
  }
  return tracer.startActiveSpan(`preview.${phase}`, run);
}

/** Per-deploy accumulator behind the timer the preview flow carries. */
export function createPhaseCollector(): {
  timer: PhaseTimer;
  phaseMs: PreviewPhaseMs;
} {
  const phaseMs: PreviewPhaseMs = {};
  return {
    phaseMs,
    timer: {
      record(phase, ms) {
        phaseMs[phase] = ms;
      },
    },
  };
}
