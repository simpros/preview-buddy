/** Display form of a configured endpoint, never the credential. */
function formatHostPath(url: URL, pathname: string = url.pathname): string {
  const path = pathname === "/" ? "" : pathname;
  return `${url.host}${path}`;
}

export type TelemetryOffReason = "SPROUT_TELEMETRY" | "DO_NOT_TRACK";

/** One decision, one value: off always names its reason. */
export type TelemetryState =
  | { enabled: true; endpoint: string; auth: string }
  | { enabled: false; reason: TelemetryOffReason };

export function formatTelemetryDestination(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return formatHostPath(url, url.pathname.replace(/\/_json\/?$/, ""));
  } catch {
    return endpoint;
  }
}

/** Boot-line and summary form of the OTLP traces endpoint. */
export function formatOtlpDestination(endpoint: string): string {
  if (endpoint === "") return "off";
  return formatHostPath(new URL(endpoint));
}

/** Boot-line and summary form of the telemetry state. */
export function describeTelemetryState(state: TelemetryState): string {
  if (!state.enabled) return `off (${state.reason})`;
  if (state.endpoint === "") return "on (no destination)";
  return `on → ${formatTelemetryDestination(state.endpoint)}`;
}
