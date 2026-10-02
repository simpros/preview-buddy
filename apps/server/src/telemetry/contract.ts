import type { BringUpPlan, PreviewPhaseMs } from "../preview/types.ts";

/**
 * Deploy-report contract both directions share. Preview reports through
 * these types without importing the telemetry feature module, and the
 * telemetry event builder maps them onto the wire shape. Type-only, so the
 * preview → contract → preview-vocabulary edge is erased at runtime and
 * can never become a real cycle.
 */

/**
 * Deploy-report contract: a success never carries failure fields, a failure
 * always carries both. Callers build one variant; the builder maps it onto
 * the matching event shape with no conditional spreads.
 */
export type TelemetryDeployOutcome =
  | {
    outcome: "running";
    plan: BringUpPlan;
    seeded: boolean;
    durationMs: number;
    phaseMs: PreviewPhaseMs;
  }
  | {
    outcome: "failed";
    plan: BringUpPlan;
    seeded: boolean;
    durationMs: number;
    phaseMs: PreviewPhaseMs;
    failureClass: string | null;
    failureFamily: string | null;
  };

/** Deploy-path hook: runAsyncDeploy reports through this, never the reporter. */
export type TelemetryDeployHook = {
  reportDeployOutcome: (outcome: TelemetryDeployOutcome) => void;
};

/**
 * Explicit no-op for deploy paths constructed without telemetry. The hook is
 * required on the deploy-side deps so the dependency is visible in the type;
 * this is the single default both edges (prod server, test helper) use.
 */
export const NO_TELEMETRY: TelemetryDeployHook = {
  reportDeployOutcome() {},
};
