import { afterEach, describe, expect, test } from "bun:test";
import { configSummary, loadConfig } from "../src/config.ts";

const REQUIRED_ENV: Record<string, string> = {
  PB_PREVIEW_POSTGRES_URL: "postgres://admin:sekrit@localhost:5432/postgres",
  PB_TRAEFIK_NETWORK: "traefik",
  PB_POSTGRES_NETWORK: "postgres",
  PB_REGISTRY_URL: "registry.example.com",
  PB_REGISTRY_USER: "puller",
  PB_REGISTRY_PASSWORD: "registry-secret",
};

const OPTIONAL_ENV = [
  "PB_TTL_HOURS",
  "PB_SWEEP_MINUTES",
  "PB_PREVIEW_PORT_DEFAULT",
  "PB_SEED_TIMEOUT",
  "PB_PORT",
] as const;

function setRequiredEnv(): void {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
}

function clearGatewayEnv(): void {
  for (const key of Object.keys(REQUIRED_ENV)) {
    delete process.env[key];
  }
  for (const key of OPTIONAL_ENV) {
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
      "Missing required environment variables: PB_PREVIEW_POSTGRES_URL, PB_TRAEFIK_NETWORK, PB_POSTGRES_NETWORK, PB_REGISTRY_URL, PB_REGISTRY_USER, PB_REGISTRY_PASSWORD",
    );
  });

  test("applies defaults for optional vars", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.ttlHours).toBe(72);
    expect(config.sweepMinutes).toBe(30);
    expect(config.previewPortDefault).toBe(8080);
    expect(config.seedTimeout).toBe(180);
    expect(config.port).toBe(7331);
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
