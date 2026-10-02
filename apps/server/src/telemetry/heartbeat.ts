import { describeTelemetryState } from "./destination.ts";

/** Daily heartbeat: boot plus every 24h on the gateway's local clock. */
export const TELEMETRY_HEARTBEAT_CRON = "0 0 * * *";

export type TelemetryHeartbeatHandle = {
  stop: () => void;
};

export function startTelemetryHeartbeat(
  onTick: () => void,
  schedule: string = TELEMETRY_HEARTBEAT_CRON,
): TelemetryHeartbeatHandle {
  // Bun.cron fires only after the previous handler settles, so heartbeats
  // never overlap; the boot fire is the caller's, never this timer's.
  const job = Bun.cron(schedule, () => {
    onTick();
  });
  return {
    stop() {
      job.stop();
    },
  };
}

export function telemetryStateLine(options: {
  enabled: boolean;
  offReason: "SPROUT_TELEMETRY" | "DO_NOT_TRACK" | null;
  endpoint: string;
}): string {
  return `telemetry ${describeTelemetryState(options)}`;
}
