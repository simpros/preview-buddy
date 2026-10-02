import type {
  PhaseTimer,
  PreviewPhase,
  PreviewPhaseMs,
} from "./types.ts";

/** Runs fn and records its wall time on the deploy's collector, if any. */
export async function timed<T>(
  deps: { phaseTimer?: PhaseTimer },
  phase: PreviewPhase,
  fn: () => Promise<T>,
): Promise<T> {
  if (!deps.phaseTimer) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    deps.phaseTimer.record(phase, Date.now() - start);
  }
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
