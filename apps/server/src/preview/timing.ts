import {
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { TRACER_NAME } from "../telemetry/tracer-name.ts";
import type { Result } from "./result.ts";
import type {
  PhaseTimer,
  PreviewPhase,
  PreviewPhaseMs,
} from "./types.ts";

/**
 * Runs fn, records wall time, and wraps it in a preview.<phase> child span.
 * Every phase returns a Result, so ERROR status derives from result.ok here
 * instead of at each call site. Generic over the whole result so call sites
 * keep their narrow error vocabularies.
 */
export async function timed<R extends Result<unknown>>(
  deps: { phaseTimer?: PhaseTimer },
  phase: PreviewPhase,
  fn: () => Promise<R>,
): Promise<R> {
  const tracer = trace.getTracer(TRACER_NAME);
  const start = Date.now();
  const run = async (span: Span): Promise<R> => {
    try {
      const result = await fn();
      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
        span.recordException(new Error(result.error));
      }
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (deps.phaseTimer) {
        deps.phaseTimer.record(phase, Date.now() - start);
      }
      span.end();
    }
  };
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
