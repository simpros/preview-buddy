import { afterEach, describe, expect, jest, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { createTestDb } from "../http/test-helpers.ts";
import {
  startTelemetryHeartbeat,
  TELEMETRY_HEARTBEAT_CRON,
} from "./heartbeat.ts";
import type { TelemetryEvent } from "./payload.ts";
import { createTelemetryReporter } from "./reporter.ts";
import {
  tempTelemetryDir,
  waitForTelemetry,
} from "./test-receiver.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function clearTelemetryEnv(): void {
  delete process.env.SPROUT_TRAEFIK_NETWORK;
  delete process.env.SPROUT_TELEMETRY;
  delete process.env.SPROUT_TELEMETRY_ENDPOINT;
  delete process.env.SPROUT_TELEMETRY_AUTH;
  delete process.env.DO_NOT_TRACK;
}

afterEach(() => {
  jest.useRealTimers();
  clearTelemetryEnv();
});

describe("telemetry heartbeat", () => {
  test("the daily schedule is a 24h cron", () => {
    expect(TELEMETRY_HEARTBEAT_CRON).toBe("0 0 * * *");
  });

  test("timer fires nothing at start, then one tick per period", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
    let ticks = 0;
    const handle = startTelemetryHeartbeat(
      () => {
        ticks += 1;
      },
      "* * * * *",
    );
    await flush();
    expect(ticks).toBe(0);
    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(ticks).toBe(1);
    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(ticks).toBe(2);
    handle.stop();
    jest.advanceTimersByTime(10 * MINUTE_MS);
    await flush();
    expect(ticks).toBe(2);
  });

  test("the daily tick fires after 24h, exactly once per period", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
    let ticks = 0;
    const handle = startTelemetryHeartbeat(() => {
      ticks += 1;
    });
    await flush();
    expect(ticks).toBe(0);
    jest.advanceTimersByTime(DAY_MS - MINUTE_MS);
    await flush();
    expect(ticks).toBe(0);
    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(ticks).toBe(1);
    jest.advanceTimersByTime(DAY_MS);
    await flush();
    expect(ticks).toBe(2);
    handle.stop();
  });

  test("reporter fires on boot and keeps one request per period", async () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    process.env.SPROUT_TELEMETRY_ENDPOINT =
      "https://telemetry.example.com/api/o/s/_json";
    process.env.SPROUT_TELEMETRY_AUTH = "Basic test-value";
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    try {
      const seen: TelemetryEvent[] = [];
      const reporter = createTelemetryReporter({
        config: loadConfig(),
        db,
        stateDbPath: tmp.stateDbPath,
        send: (_endpoint, _auth, event) => {
          seen.push(event);
        },
      });
      const handle = reporter.startHeartbeat("* * * * *");
      await waitForTelemetry(() => seen.length > 0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.event).toBe("install");
      handle.stop();
    } finally {
      await cleanup();
      await tmp.cleanup();
    }
  });
});
