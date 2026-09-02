import { afterEach, describe, expect, test } from "bun:test";
import {
  configSummary,
  loadConfig,
  OPTIONAL_ENV_DEFAULTS,
  REQUIRED_ENV,
} from "../src/config.ts";

const TEST_REQUIRED_VALUES: Record<(typeof REQUIRED_ENV)[number], string> = {
  PB_PREVIEW_POSTGRES_URL: "postgres://admin:sekrit@localhost:5432/postgres",
  PB_TRAEFIK_NETWORK: "traefik",
  PB_POSTGRES_NETWORK: "postgres",
  PB_REGISTRY_URL: "registry.example.com",
  PB_REGISTRY_USER: "puller",
  PB_REGISTRY_PASSWORD: "registry-secret",
};

function setRequiredEnv(): void {
  for (const key of REQUIRED_ENV) {
    process.env[key] = TEST_REQUIRED_VALUES[key];
  }
}

function clearGatewayEnv(): void {
  for (const key of REQUIRED_ENV) {
    delete process.env[key];
  }
  for (const key of Object.keys(OPTIONAL_ENV_DEFAULTS)) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearGatewayEnv();
});

describe("loadConfig", () => {
  test("fails fast when required vars are missing", () => {
    clearGatewayEnv();
    expect(() => loadConfig()).toThrow(
      `Missing required environment variables: ${REQUIRED_ENV.join(", ")}`,
    );
  });

  test("applies defaults for optional vars", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.ttlHours).toBe(OPTIONAL_ENV_DEFAULTS.PB_TTL_HOURS);
    expect(config.sweepMinutes).toBe(OPTIONAL_ENV_DEFAULTS.PB_SWEEP_MINUTES);
    expect(config.previewPortDefault).toBe(
      OPTIONAL_ENV_DEFAULTS.PB_PREVIEW_PORT_DEFAULT,
    );
    expect(config.seedTimeout).toBe(OPTIONAL_ENV_DEFAULTS.PB_SEED_TIMEOUT);
    expect(config.port).toBe(OPTIONAL_ENV_DEFAULTS.PB_PORT);
  });

  test("rejects non-numeric optional env vars", () => {
    setRequiredEnv();
    process.env.PB_PORT = "7331x";
    expect(() => loadConfig()).toThrow(
      "Invalid PB_PORT: must be a positive integer",
    );
  });

  test("rejects whitespace-only required env vars", () => {
    setRequiredEnv();
    process.env.PB_PREVIEW_POSTGRES_URL = "   ";
    expect(() => loadConfig()).toThrow(
      "Missing required environment variables: PB_PREVIEW_POSTGRES_URL",
    );
  });

  test("configSummary redacts secrets", () => {
    const summary = configSummary({
      previewPostgresUrl: "postgres://admin:sekrit@localhost:5432/postgres",
      traefikNetwork: "traefik",
      postgresNetwork: "postgres",
      registryUrl: "registry.example.com",
      registryUser: "puller",
      registryPassword: "registry-secret",
      ttlHours: 72,
      sweepMinutes: 30,
      previewPortDefault: 8080,
      seedTimeout: 180,
      port: 7331,
    });

    expect(String(summary.previewPostgresUrl)).not.toContain("sekrit");
    expect(summary.registryPassword).toBe("[set]");
    expect(summary.registryUser).toBe("puller");
  });
});
