import type { BringUpPlan, PreviewPhaseMs } from "../preview/types.ts";

/**
 * Deploy-report contract both directions share. Preview reports through
 * these types without importing the telemetry feature module, and the
 * telemetry event builder maps them onto the wire shape. Type-only, so the
 * preview → contract → preview-vocabulary edge is erased at runtime and
 * can never become a real cycle.
 */

/** Shared with the preview domain: the stored plan feeds the report unchanged. */
export type TelemetryPlan = BringUpPlan;

/** Shared with the preview domain: the phase stopwatch feeds the report unchanged. */
export type TelemetryPhaseMs = PreviewPhaseMs;

/**
 * Deploy-report contract: a success never carries failure fields, a failure
 * always carries both. Callers build one variant; the builder maps it onto
 * the matching event shape with no conditional spreads.
 */
export type TelemetryDeployOutcome =
  | {
    outcome: "running";
    plan: TelemetryPlan;
    seeded: boolean;
    durationMs: number;
    phaseMs: TelemetryPhaseMs;
  }
  | {
    outcome: "failed";
    plan: TelemetryPlan;
    seeded: boolean;
    durationMs: number;
    phaseMs: TelemetryPhaseMs;
    failureClass: string | null;
    failureFamily: string | null;
  };

/** Deploy-path hook: runAsyncDeploy reports through this, never the reporter. */
export type TelemetryDeployHook = {
  reportDeployOutcome: (outcome: TelemetryDeployOutcome) => void;
};
