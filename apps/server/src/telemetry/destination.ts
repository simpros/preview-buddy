/** Display form of a configured telemetry endpoint, never the credential. */

export type TelemetryOffReason = "SPROUT_TELEMETRY" | "DO_NOT_TRACK";

/** One decision, one value: off always names its reason. */
export type TelemetryState =
  | { enabled: true; endpoint: string }
  | { enabled: false; reason: TelemetryOffReason };

export function formatTelemetryDestination(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/_json\/?$/, "");
    return `${url.host}${path}`;
  } catch {
    return endpoint;
  }
}

/** Boot-line and summary form of the telemetry state. */
export function describeTelemetryState(state: TelemetryState): string {
  if (!state.enabled) return `off (${state.reason})`;
  if (state.endpoint === "") return "on (no destination)";
  return `on → ${formatTelemetryDestination(state.endpoint)}`;
}
