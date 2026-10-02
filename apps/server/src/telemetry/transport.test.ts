import { afterEach, describe, expect, test } from "bun:test";
import { postTelemetryEvent } from "./transport.ts";
import type { TelemetryEvent } from "./payload.ts";

type CapturedRequest = {
  method: string;
  contentType: string | null;
  authorization: string | null;
  body: unknown;
};

function testEvent(): TelemetryEvent {
  return {
    event: "install",
    install_id: "3f9d7a1e-8b2c-4d5e-9f01-23456789abcd",
    sprout_version: "test",
    runtime: "bun test",
    platform: "test/test",
    db_provider: "sqlite",
    capabilities: ["volumes", "services"],
    _timestamp: new Date(0).toISOString(),
    previews_total: 0,
    deploys_total: 0,
  };
}

let warns: string[] = [];
const originalWarn = console.warn;

function captureWarns(): void {
  warns = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
}

afterEach(() => {
  console.warn = originalWarn;
});

async function withReceiver(
  respond: (req: Request) => Response | Promise<Response>,
  run: (url: string, captured: CapturedRequest[]) => Promise<void>,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        method: req.method,
        contentType: req.headers.get("content-type"),
        authorization: req.headers.get("authorization"),
        body: await req.json(),
      });
      return respond(req);
    },
  });
  try {
    await run(`http://127.0.0.1:${server.port}/api/o/s/_json`, captured);
  } finally {
    server.stop(true);
  }
  return captured;
}

describe("telemetry transport", () => {
  test("posts a one-element JSON array with auth", async () => {
    captureWarns();
    const event = testEvent();
    const captured = await withReceiver(
      () => new Response('{"failed":0}', { status: 200 }),
      async (url) => {
        await postTelemetryEvent(url, "Basic test-value", event);
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.contentType).toBe("application/json");
    expect(captured[0]?.authorization).toBe("Basic test-value");
    expect(captured[0]?.body).toEqual([event]);
    expect(warns).toEqual([]);
  });

  test("401, 403 and 500 never throw and warn once with the status", async () => {
    for (const status of [401, 403, 500]) {
      captureWarns();
      await withReceiver(
        () => new Response("nope", { status }),
        async (url) => {
          await postTelemetryEvent(url, "Basic test-value", testEvent());
        },
      );
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(String(status));
    }
  });

  test("closed port never throws and warns at most once", async () => {
    captureWarns();
    await postTelemetryEvent(
      "http://127.0.0.1:1/api/o/s/_json",
      "Basic test-value",
      testEvent(),
    );
    expect(warns.length).toBeLessThanOrEqual(1);
    expect(warns).toHaveLength(1);
  });

  test("a receiver that never responds is abandoned, never awaited forever", async () => {
    captureWarns();
    const startedAt = Date.now();
    await withReceiver(
      () => new Promise<Response>(() => {}),
      async (url) => {
        await postTelemetryEvent(url, "Basic test-value", testEvent());
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(warns).toHaveLength(1);
  });
});
