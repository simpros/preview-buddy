import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { createTestDb } from "../http/test-helpers.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { createTelemetryReporter } from "./reporter.ts";
import {
  captureConsoleWarn,
  startTelemetryReceiver,
  tempTelemetryDir,
  waitForTelemetry,
} from "./test-receiver.ts";
import type { TelemetryEvent } from "./payload.ts";

const REQUIRED = "SPROUT_TRAEFIK_NETWORK";

function setGatewayEnv(values: Record<string, string>): void {
  process.env[REQUIRED] = "traefik";
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function clearTelemetryEnv(): void {
  delete process.env[REQUIRED];
  delete process.env.SPROUT_TELEMETRY;
  delete process.env.SPROUT_TELEMETRY_ENDPOINT;
  delete process.env.SPROUT_TELEMETRY_AUTH;
  delete process.env.DO_NOT_TRACK;
}

afterEach(() => {
  clearTelemetryEnv();
});

describe("telemetry reporter", () => {
  test("unconfigured gateway boots on, sends nothing", async () => {
    setGatewayEnv({});
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    try {
      const config = loadConfig();
      expect(config.telemetryEnabled).toBe(true);
      const seen: TelemetryEvent[] = [];
      const reporter = createTelemetryReporter({
        config,
        db,
        stateDbPath: tmp.stateDbPath,
        send: (_e, _a, event) => {
          seen.push(event);
        },
      });
      expect(reporter.active).toBe(false);
      expect(reporter.describe()).toBe("on (no destination)");
      reporter.reportInstall();
      reporter.reportDeployOutcome({
        outcome: "running",
        plan: "full_replace",
        seeded: false,
        durationMs: 1,
        phaseMs: {},
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(seen).toEqual([]);
    } finally {
      await cleanup();
      await tmp.cleanup();
    }
  });

  test("describe names the destination host, never the credential", async () => {
    setGatewayEnv({
      SPROUT_TELEMETRY_ENDPOINT:
        "https://telemetry.example.com/api/o/s/_json",
      SPROUT_TELEMETRY_AUTH: "Basic test-value",
    });
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    try {
      const reporter = createTelemetryReporter({
        config: loadConfig(),
        db,
        stateDbPath: tmp.stateDbPath,
      });
      expect(reporter.describe()).toStartWith("on → ");
      expect(reporter.describe()).toContain("telemetry.example.com");
      expect(reporter.describe()).not.toContain("test-value");
    } finally {
      await cleanup();
      await tmp.cleanup();
    }
  });

  test("install heartbeat counts rows and writes the id file", async () => {
    const receiver = await startTelemetryReceiver();
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    try {
      await db.insert(previews).values([
        {
          canonicalRepoId: "https://github.com/org/a",
          prId: 1,
          slug: "a",
          hostname: "pr-1.example.com",
          status: "running",
        },
        {
          canonicalRepoId: "https://github.com/org/b",
          prId: 2,
          slug: "b",
          hostname: "pr-2.example.com",
          status: "failed",
        },
        {
          canonicalRepoId: "https://github.com/org/c",
          prId: 3,
          slug: "c",
          hostname: "pr-3.example.com",
          status: "removed",
        },
        {
          canonicalRepoId: "https://github.com/org/d",
          prId: 4,
          slug: "d",
          hostname: "pr-4.example.com",
          status: "provisioning",
        },
      ]);
      setGatewayEnv({
        SPROUT_TELEMETRY_ENDPOINT: receiver.url,
        SPROUT_TELEMETRY_AUTH: "Basic test-value",
      });
      const config = loadConfig();
      const reporter = createTelemetryReporter({
        config,
        db,
        stateDbPath: tmp.stateDbPath,
      });
      expect(reporter.active).toBe(true);
      reporter.reportInstall();
      await waitForTelemetry(() => receiver.captured.length > 0);
      expect(receiver.captured).toHaveLength(1);
      const [first] = receiver.captured;
      expect(first?.authorization).toBe("Basic test-value");
      const [event] = first?.body as Array<Record<string, unknown>>;
      expect(event?.event).toBe("install");
      expect(event?.previews_total).toBe(3);
      expect(event?.deploys_total).toBe(2);
      expect(typeof event?.install_id).toBe("string");
      const idFile = await Bun.file(`${tmp.dir}/install-id`).text();
      expect(idFile.trim()).toBe(String(event?.install_id));
    } finally {
      receiver.stop();
      await cleanup();
      await tmp.cleanup();
    }
  });

  test("off switches each yield zero requests", async () => {
    for (const env of [
      { SPROUT_TELEMETRY: "off" },
      { DO_NOT_TRACK: "1" },
    ] as Record<string, string>[]) {
      const receiver = await startTelemetryReceiver();
      const { db, cleanup } = await createTestDb();
      const tmp = await tempTelemetryDir();
      const { warns, restore } = captureConsoleWarn();
      try {
        setGatewayEnv({
          SPROUT_TELEMETRY_ENDPOINT: receiver.url,
          SPROUT_TELEMETRY_AUTH: "Basic test-value",
          ...env,
        });
        const config = loadConfig();
        const reporter = createTelemetryReporter({
          config,
          db,
          stateDbPath: tmp.stateDbPath,
        });
        expect(reporter.active).toBe(false);
        reporter.reportInstall();
        reporter.startHeartbeat();
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(receiver.captured).toEqual([]);
        expect(warns).toEqual([]);
      } finally {
        restore();
        receiver.stop();
        await cleanup();
        await tmp.cleanup();
        clearTelemetryEnv();
      }
    }
  });

  test("runtime destination wins over the image values", async () => {
    const imageReceiver = await startTelemetryReceiver();
    const runtimeReceiver = await startTelemetryReceiver();
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    try {
      // The image carries one destination; the operator overrides both keys.
      setGatewayEnv({
        SPROUT_TELEMETRY_ENDPOINT: runtimeReceiver.url,
        SPROUT_TELEMETRY_AUTH: "Basic runtime-value",
      });
      const config = loadConfig();
      expect(config.telemetryEndpoint).toBe(runtimeReceiver.url);
      const reporter = createTelemetryReporter({
        config,
        db,
        stateDbPath: tmp.stateDbPath,
      });
      reporter.reportInstall();
      await waitForTelemetry(() => runtimeReceiver.captured.length > 0);
      expect(imageReceiver.captured).toEqual([]);
      expect(runtimeReceiver.captured).toHaveLength(1);
    } finally {
      imageReceiver.stop();
      runtimeReceiver.stop();
      await cleanup();
      await tmp.cleanup();
    }
  });

  test("deploy outcome exports without blocking the caller", async () => {
    const receiver = await startTelemetryReceiver();
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    try {
      setGatewayEnv({
        SPROUT_TELEMETRY_ENDPOINT: receiver.url,
        SPROUT_TELEMETRY_AUTH: "Basic test-value",
      });
      const reporter = createTelemetryReporter({
        config: loadConfig(),
        db,
        stateDbPath: tmp.stateDbPath,
      });
      const startedAt = Date.now();
      reporter.reportDeployOutcome({
        outcome: "failed",
        plan: "full_replace",
        seeded: false,
        durationMs: 9,
        phaseMs: { app: 9 },
        failureClass: "preview_app_pull_failed",
        failureFamily: null,
      });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await waitForTelemetry(() => receiver.captured.length > 0);
      const [event] = receiver.captured[0]?.body as Array<
        Record<string, unknown>
      >;
      expect(event?.event).toBe("deploy");
      expect(event?.outcome).toBe("failed");
      expect(event?.failure_class).toBe("preview_app_pull_failed");
      expect(event?.failure_family).toBeNull();
    } finally {
      receiver.stop();
      await cleanup();
      await tmp.cleanup();
    }
  });

  test("export failures never throw and warn at most once", async () => {
    const { db, cleanup } = await createTestDb();
    const tmp = await tempTelemetryDir();
    const { warns, restore } = captureConsoleWarn();
    try {
      setGatewayEnv({
        SPROUT_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/api/o/s/_json",
        SPROUT_TELEMETRY_AUTH: "Basic test-value",
      });
      const reporter = createTelemetryReporter({
        config: loadConfig(),
        db,
        stateDbPath: tmp.stateDbPath,
      });
      reporter.reportInstall();
      reporter.reportDeployOutcome({
        outcome: "running",
        plan: "close",
        seeded: false,
        durationMs: 1,
        phaseMs: {},
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(warns.length).toBeLessThanOrEqual(2);
    } finally {
      restore();
      await cleanup();
      await tmp.cleanup();
    }
  });
});
