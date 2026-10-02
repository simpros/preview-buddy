import type { TelemetryEvent } from "./payload.ts";

/**
 * One JSON fetch per event: POST the one-element array, 3s timeout, no
 * retries, no queue, no batching. Every failure collapses to at most one
 * console.warn carrying the status code; nothing is ever thrown.
 */

export async function postTelemetryEvent(
  endpoint: string,
  auth: string,
  event: TelemetryEvent,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    console.warn(
      `telemetry export failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!response.ok) {
    console.warn(`telemetry export failed: ${response.status}`);
  }
}

/** Fire-and-forget: never awaited on a deploy, request, sweep or boot path. */
export function sendTelemetryEvent(
  endpoint: string,
  auth: string,
  event: TelemetryEvent,
): void {
  void postTelemetryEvent(endpoint, auth, event);
}
