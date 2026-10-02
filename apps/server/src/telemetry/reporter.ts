import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { resolveStateDbPath } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import type {
  TelemetryDeployHook,
  TelemetryDeployOutcome,
} from "./contract.ts";
import { describeTelemetryState } from "./destination.ts";
import {
  startTelemetryHeartbeat,
  type TelemetryHeartbeatHandle,
} from "./heartbeat.ts";
import { loadOrCreateInstallId } from "./install-id.ts";
import {
  buildDeployEvent,
  buildInstallEvent,
  type TelemetryEvent,
} from "./payload.ts";
import { sendTelemetryEvent } from "./transport.ts";

export type {
  TelemetryDeployHook,
  TelemetryDeployOutcome,
} from "./contract.ts";

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
  const stateDbPath = deps.stateDbPath ?? resolveStateDbPath();
  const now = deps.now ?? Date.now;
  const send = deps.send ?? sendTelemetryEvent;
  const state = config.telemetry;
  const active = state.enabled && state.endpoint !== "";

  async function exportEvent(
    build: (installId: string) => TelemetryEvent | Promise<TelemetryEvent>,
  ): Promise<void> {
    if (!active || !state.enabled) return;
    try {
      const installId = await loadOrCreateInstallId(stateDbPath);
      send(state.endpoint, state.auth, await build(installId));
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
    describe: () => describeTelemetryState(state),
    reportInstall,
    reportDeployOutcome,
    startHeartbeat: (schedule?: string) => {
      reportInstall();
      return startTelemetryHeartbeat(reportInstall, schedule);
    },
  };
}
