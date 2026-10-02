import type { StateDb } from "../infrastructure/db/client.ts";
import type { TelemetryDeployOutcome } from "../telemetry/payload.ts";
import { getPreviewRow } from "./lifecycle.ts";
import type { BringUpPlan, PreviewPhaseMs } from "./types.ts";

export type DeployOutcomeRef = {
  repo: string;
  prId: number;
  plan: BringUpPlan;
  startedAt: number;
  phaseMs: PreviewPhaseMs;
};

/**
 * Read the terminal row and shape this deploy's report. Callers invoke this
 * before clearing the in-flight marker, so the read still describes this
 * deploy and never a successor's.
 */
export async function captureDeployOutcome(
  db: StateDb,
  ref: DeployOutcomeRef,
): Promise<TelemetryDeployOutcome | null> {
  try {
    const row = await getPreviewRow(db, ref.repo, ref.prId);
    const base = {
      plan: ref.plan,
      seeded: row?.seededAt != null,
      durationMs: Date.now() - ref.startedAt,
      phaseMs: ref.phaseMs,
    };
    if (row?.status !== "running") {
      return {
        ...base,
        outcome: "failed" as const,
        failureClass: row?.lastError ?? null,
        failureFamily: row?.failureFamily ?? null,
      };
    }
    return { ...base, outcome: "running" as const };
  } catch {
    // Telemetry must never change a deploy outcome.
    return null;
  }
}
