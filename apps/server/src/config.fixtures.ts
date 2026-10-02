import type { Config } from "./config.ts";
import { governanceConfig } from "./preview/governance-fixtures.ts";

/** Minimal test gateway config; callers override only what they assert on. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    traefikNetwork: "traefik",
    registryPullAuth: { byHost: new Map() },
    githubToken: "",
    gitlabToken: "",
    extraGitlabHosts: new Set(),
    ttlHours: 72,
    legacyTtlMs: 72 * 3600_000,
    sweepCron: "*/30 * * * *",
    previewPortDefault: 8080,
    seedTimeout: 180,
    port: 7331,
    dashboard: { enabled: false, user: "", password: "" },
    telemetry: { enabled: true, endpoint: "", auth: "" },
    otlp: { endpoint: "", headers: {} },
    governance: governanceConfig(),
    ...overrides,
  };
}
