import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CapturedTelemetryRequest = {
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
};

export type TelemetryReceiver = {
  url: string;
  captured: CapturedTelemetryRequest[];
  stop: () => void;
};

/** Local stand-in for the maintainer ingest endpoint. */
export async function startTelemetryReceiver(
  respond: (req: Request, body: unknown) => Response | Promise<Response> = () =>
    new Response('{"failed":0}', { status: 200 }),
): Promise<TelemetryReceiver> {
  const captured: CapturedTelemetryRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: unknown = await req.json().catch(() => null);
      captured.push({
        method: req.method,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      return respond(req, body);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/api/o/s/_json`,
    captured,
    stop: () => server.stop(true),
  };
}

export async function waitForTelemetry(
  check: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for telemetry export");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function tempTelemetryDir(): Promise<{
  dir: string;
  stateDbPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "sprout-telemetry-"));
  const { rm } = await import("node:fs/promises");
  return {
    dir,
    stateDbPath: join(dir, "sprout.db"),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function captureConsoleWarn(): {
  warns: string[];
  restore: () => void;
} {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  return {
    warns,
    restore: () => {
      console.warn = original;
    },
  };
}
