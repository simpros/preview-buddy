import {
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { TRACER_NAME } from "../telemetry/tracer-name.ts";
import type { Result } from "./result.ts";
import type {
  PhaseTimer,
  PreviewPhase,
  PreviewPhaseMs,
} from "./types.ts";

/** Runs fn, records wall time, and wraps it in a preview.<phase> child span. */
export async function timed<T, E extends string>(
  deps: { phaseTimer?: PhaseTimer; traceContext?: Context },
  phase: PreviewPhase,
  fn: () => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  const tracer = trace.getTracer(TRACER_NAME);
  const start = Date.now();
  const run = async (span: Span): Promise<Result<T, E>> => {
    try {
      const result = await fn();
      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
        span.recordException(new Error(result.error));
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
