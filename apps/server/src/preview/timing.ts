import {
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { TRACER_NAME } from "../telemetry/tracer-name.ts";
import { ambientTraceContext } from "../telemetry/trace-context.ts";
import type {
  PhaseTimer,
  PreviewPhase,
  PreviewPhaseMs,
} from "./types.ts";

/**
 * Runs fn, records wall time, and wraps it in a preview.<phase> child span.
 * The timer knows nothing about what fn returns: callers that treat a value
 * as failure pass a classifier mapping it to an error message, and the span
 * records ERROR for exactly those.
 */
export async function timed<T>(
  deps: { phaseTimer?: PhaseTimer },
  phase: PreviewPhase,
  fn: () => Promise<T>,
  classifyError?: (value: T) => string | undefined,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const start = Date.now();
  const run = async (span: Span): Promise<T> => {
    try {
      const value = await fn();
      const message = classifyError?.(value);
      if (message !== undefined) {
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.recordException(new Error(message));
      }
      return value;
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
  // The deploy root binds its context into storage at span creation; the
  // OTel manager cannot be trusted for the ambient parent here, so read it
  // back explicitly. Without a bound deploy the span parents ambiently.
  const parent = ambientTraceContext();
  if (parent) {
    return tracer.startActiveSpan(`preview.${phase}`, {}, parent, run);
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
