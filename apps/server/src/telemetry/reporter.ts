import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { describeTelemetryState } from "./destination.ts";
import {
  startTelemetryHeartbeat,
  type TelemetryHeartbeatHandle,
} from "./heartbeat.ts";
import { loadOrCreateInstallId, stateDbPathFromEnv } from "./install-id.ts";
import {
  buildDeployEvent,
  buildInstallEvent,
  type TelemetryDeployEvent,
  type TelemetryEvent,
  type TelemetryOutcome,
  type TelemetryPhaseMs,
  type TelemetryPlan,
} from "./payload.ts";
import { sendTelemetryEvent } from "./transport.ts";

export type TelemetryDeployOutcome = {
  outcome: TelemetryOutcome;
  plan: TelemetryPlan;
  seeded: boolean;
  durationMs: number;
  phaseMs: TelemetryPhaseMs;
  failureClass?: string | null;
  failureFamily?: string | null;
};

/** Deploy-path hook: runAsyncDeploy reports through this, never the reporter. */
export type TelemetryDeployHook = {
  reportDeployOutcome: (outcome: TelemetryDeployOutcome) => void;
};

export type TelemetryReporter = TelemetryDeployHook & {
  readonly active: boolean;
  describe: () => string;
  reportInstall: () => void;
  startHeartbeat: (schedule?: string) => TelemetryHeartbeatHandle;
};

export function createTelemetryReporter(deps: {
  config: Config;
  db: StateDb;
  stateDbPath?: string;
  now?: () => number;
  send?: (endpoint: string, auth: string, event: TelemetryEvent) => void;
}): TelemetryReporter {
  const config = deps.config;
  const db = deps.db;
  const stateDbPath = deps.stateDbPath ?? stateDbPathFromEnv();
  const now = deps.now ?? Date.now;
  const send = deps.send ?? sendTelemetryEvent;
  const active = config.telemetryEnabled && config.telemetryEndpoint !== "";

  async function exportEvent(
    build: (installId: string) => TelemetryEvent,
  ): Promise<void> {
    if (!active) return;
    try {
      const installId = await loadOrCreateInstallId(stateDbPath);
      send(config.telemetryEndpoint, config.telemetryAuth, build(installId));
    } catch (error) {
      console.warn(
        `telemetry export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function installCounts(): Promise<{
    previewsTotal: number;
    deploysTotal: number;
  }> {
    const rows = await db.select({ status: previews.status }).from(previews);
    return {
      previewsTotal: rows.filter((row) => row.status !== "removed").length,
      deploysTotal: rows.filter(
        (row) => row.status === "running" || row.status === "failed",
      ).length,
    };
  }

  function reportInstall(): void {
    if (!active) return;
    void (async () => {
      try {
        const installId = await loadOrCreateInstallId(stateDbPath);
        const counts = await installCounts();
        send(
          config.telemetryEndpoint,
          config.telemetryAuth,
          buildInstallEvent({
            installId,
            config,
            previewsTotal: counts.previewsTotal,
            deploysTotal: counts.deploysTotal,
            now: now(),
          }),
        );
      } catch (error) {
        console.warn(
          `telemetry export failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })().catch(() => {});
  }

  function reportDeployOutcome(outcome: TelemetryDeployOutcome): void {
    void exportEvent((installId): TelemetryDeployEvent => {
      return buildDeployEvent({
        installId,
        config,
        outcome: outcome.outcome,
        plan: outcome.plan,
        seeded: outcome.seeded,
        durationMs: outcome.durationMs,
        phaseMs: outcome.phaseMs,
        ...(outcome.failureClass !== undefined
          ? { failureClass: outcome.failureClass }
          : {}),
        ...(outcome.failureFamily !== undefined
          ? { failureFamily: outcome.failureFamily }
          : {}),
        now: now(),
      });
    }).catch(() => {});
  }

  return {
    active,
    describe: () =>
      describeTelemetryState({
        enabled: config.telemetryEnabled,
        offReason: config.telemetryOffReason,
        endpoint: config.telemetryEndpoint,
      }),
    reportInstall,
    reportDeployOutcome,
    startHeartbeat: (schedule?: string) => {
      reportInstall();
      return startTelemetryHeartbeat(reportInstall, schedule);
    },
  };
}
