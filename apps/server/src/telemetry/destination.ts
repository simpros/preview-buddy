/** Display form of a configured telemetry endpoint, never the credential. */

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
export function describeTelemetryState(options: {
  enabled: boolean;
  offReason: "SPROUT_TELEMETRY" | "DO_NOT_TRACK" | null;
  endpoint: string;
}): string {
  if (!options.enabled) return `off (${options.offReason ?? "SPROUT_TELEMETRY"})`;
  if (options.endpoint === "") return "on (no destination)";
  return `on → ${formatTelemetryDestination(options.endpoint)}`;
}
