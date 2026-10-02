import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  buildDeployEvent,
  buildInstallEvent,
  capabilitiesFromConfig,
  dbProviderFromConfig,
  DEPLOY_FAILED_EVENT_KEYS,
  DEPLOY_SUCCESS_EVENT_KEYS,
  INSTALL_EVENT_KEYS,
  parseTelemetryPlan,
  sproutVersion,
  TELEMETRY_CAPABILITY_VOCABULARY,
  telemetryPlatform,
  telemetryRuntime,
} from "./payload.ts";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    traefikNetwork: "traefik",
    registryPullAuth: { byHost: new Map() },
    githubToken: "",
    gitlabToken: "",
    extraGitlabHosts: new Set(),
    ttlHours: 72,
    sweepCron: "*/30 * * * *",
    previewPortDefault: 8080,
    seedTimeout: 180,
    port: 7331,
    telemetryEnabled: true,
    telemetryOffReason: null,
    telemetryEndpoint: "",
    telemetryAuth: "",
    ...overrides,
  };
}

const INSTALL_ID = "3f9d7a1e-8b2c-4d5e-9f01-23456789abcd";
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

describe("telemetry payload", () => {
  test("version is read from the root package.json, never a literal", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../../package.json"), "utf8"),
    ) as { version: string };
    expect(sproutVersion()).toBe(pkg.version);
  });

  test("install event carries the exact key set", () => {
    const event = buildInstallEvent({
      installId: INSTALL_ID,
      config: testConfig(),
      previewsTotal: 2,
      deploysTotal: 1,
      now: NOW,
    });
    expect([...Object.keys(event)].sort()).toEqual(
      [...INSTALL_EVENT_KEYS].sort(),
    );
    expect(event.event).toBe("install");
    expect(event.install_id).toBe(INSTALL_ID);
    expect(event.previews_total).toBe(2);
    expect(event.deploys_total).toBe(1);
    expect(event._timestamp).toBe("2026-09-30T12:00:00.000Z");
    expect(event.sprout_version).toBe(sproutVersion());
    expect(event.runtime).toBe(telemetryRuntime());
    expect(event.platform).toBe(telemetryPlatform());
  });

  test("successful deploy carries the exact success key set", () => {
    const event = buildDeployEvent({
      installId: INSTALL_ID,
      config: testConfig(),
      outcome: "running",
      plan: "full_replace",
      seeded: false,
      durationMs: 1234.6,
      phaseMs: { db: 10.2, app: 800 },
      now: NOW,
    });
    expect([...Object.keys(event)].sort()).toEqual(
      [...DEPLOY_SUCCESS_EVENT_KEYS].sort(),
    );
    expect(event.outcome).toBe("running");
    expect(event.plan).toBe("full_replace");
    expect(event.seeded).toBe(false);
    expect(event.duration_ms).toBe(1235);
    expect(event.phase_ms).toEqual({ db: 10, app: 800 });
    expect("failure_class" in event).toBe(false);
    expect("failure_family" in event).toBe(false);
  });

  test("failed deploy carries failure class and family, never detail", () => {
    const event = buildDeployEvent({
      installId: INSTALL_ID,
      config: testConfig(),
      outcome: "failed",
      plan: "seed_resume",
      seeded: false,
      durationMs: 42,
      phaseMs: { app: 40 },
      failureClass: "seed_failed",
      failureFamily: "seed_incomplete",
      now: NOW,
    });
    expect([...Object.keys(event)].sort()).toEqual(
      [...DEPLOY_FAILED_EVENT_KEYS].sort(),
    );
    expect(event.failure_class).toBe("seed_failed");
    expect(event.failure_family).toBe("seed_incomplete");
    expect("lastErrorDetail" in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain("lastErrorDetail");
  });

  test("failed deploy without a stored code reports unknown", () => {
    const event = buildDeployEvent({
      installId: INSTALL_ID,
      config: testConfig(),
      outcome: "failed",
      plan: "full_replace",
      seeded: false,
      durationMs: 7,
      phaseMs: {},
      failureClass: null,
      failureFamily: null,
      now: NOW,
    });
    expect(event.failure_class).toBe("unknown");
    expect(event.failure_family).toBe("unknown");
  });

  test("phase keys outside the closed vocabulary are dropped", () => {
    const event = buildDeployEvent({
      installId: INSTALL_ID,
      config: testConfig(),
      outcome: "running",
      plan: "close",
      seeded: true,
      durationMs: 5,
      phaseMs: { db: 1, pull: 99 } as unknown as { db: number },
      now: NOW,
    });
    expect(event.phase_ms).toEqual({ db: 1 });
  });

  test("db provider follows gateway config", () => {
    expect(dbProviderFromConfig(testConfig())).toBe("sqlite");
    expect(
      dbProviderFromConfig(
        testConfig({
          postgres: {
            url: "postgres://u@/db",
            host: "postgres",
            port: 5432,
            user: "u",
            password: "p",
            network: "postgres",
          },
        }),
      ),
    ).toBe("postgres");
  });

  test("capabilities stay inside the closed vocabulary", () => {
    const vocab = new Set<string>(TELEMETRY_CAPABILITY_VOCABULARY);
    const bare = capabilitiesFromConfig(testConfig());
    expect(bare.length).toBeGreaterThan(0);
    for (const capability of bare) expect(vocab.has(capability)).toBe(true);
    const full = capabilitiesFromConfig(
      testConfig({
        mail: {
          host: "mailpit",
          port: 1025,
          secure: false,
          fromDomain: "preview.invalid",
        },
        traefikTls: { entrypoints: "https" },
        traefikForwardAuth: { middleware: "m", address: "https://a/x" },
        gitlabToken: "gl",
        extraGitlabHosts: new Set(["git.example.com"]),
      }),
    );
    expect(new Set(full)).toEqual(
      new Set([
        "mail",
        "tls",
        "forwardauth",
        "volumes",
        "services",
        "gitlab",
        "custom_forge_hosts",
      ]),
    );
  });

  test("unknown plans fall back to full_replace", () => {
    expect(parseTelemetryPlan(null)).toBe("full_replace");
    expect(parseTelemetryPlan("sync_close")).toBe("sync_close");
    expect(parseTelemetryPlan("injected-plan")).toBe("full_replace");
  });
});
