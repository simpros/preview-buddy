import type { Config } from "../config.ts";
import { telemetryStateFromConfig } from "../config.ts";
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
  type TelemetryDeployOutcome,
  type TelemetryEvent,
} from "./payload.ts";
import { sendTelemetryEvent } from "./transport.ts";

export type { TelemetryDeployOutcome } from "./payload.ts";

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
    build: (installId: string) => TelemetryEvent | Promise<TelemetryEvent>,
  ): Promise<void> {
    if (!active) return;
    try {
      const installId = await loadOrCreateInstallId(stateDbPath);
      send(config.telemetryEndpoint, config.telemetryAuth, await build(installId));
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
    void exportEvent(async (installId) => {
      const counts = await installCounts();
      return buildInstallEvent({
        installId,
        config,
        previewsTotal: counts.previewsTotal,
        deploysTotal: counts.deploysTotal,
        now: now(),
      });
    });
  }

  function reportDeployOutcome(outcome: TelemetryDeployOutcome): void {
    // exportEvent never rejects; the single guarded builder above owns the
    // only failure path, so there is nothing to catch here.
    void exportEvent((installId) =>
      buildDeployEvent({ installId, config, outcome, now: now() }),
    );
  }

  return {
    active,
    describe: () =>
      describeTelemetryState(telemetryStateFromConfig(config)),
    reportInstall,
    reportDeployOutcome,
    startHeartbeat: (schedule?: string) => {
      reportInstall();
      return startTelemetryHeartbeat(reportInstall, schedule);
    },
  };
}
