import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";

/**
 * Anonymous install-telemetry payload. The payload is assembled from a fixed
 * field list in this module; no string from an error, a manifest, the
 * environment or a database row passes through except the three
 * closed-vocabulary values lastError, failureFamily and plan.
 */

export const TELEMETRY_CAPABILITY_VOCABULARY = [
  "mail",
  "tls",
  "forwardauth",
  "volumes",
  "services",
  "gitlab",
  "custom_forge_hosts",
] as const;

export type TelemetryCapability =
  (typeof TELEMETRY_CAPABILITY_VOCABULARY)[number];

export type TelemetryDbProvider = "postgres" | "sqlite";

export type TelemetryPlan =
  | "full_replace"
  | "seed_resume"
  | "sync_close"
  | "close";

export type TelemetryOutcome = "running" | "failed";

export type TelemetryPhaseMs = {
  db?: number;
  app?: number;
  seed?: number;
};

type TelemetryEnvelope = {
  event: string;
  install_id: string;
  sprout_version: string;
  runtime: string;
  platform: string;
  db_provider: TelemetryDbProvider;
  capabilities: TelemetryCapability[];
  _timestamp: string;
};

export type TelemetryInstallEvent = TelemetryEnvelope & {
  event: "install";
  previews_total: number;
  deploys_total: number;
};

export type TelemetryDeployEvent = TelemetryEnvelope & {
  event: "deploy";
  outcome: TelemetryOutcome;
  plan: TelemetryPlan;
  seeded: boolean;
  duration_ms: number;
  phase_ms: TelemetryPhaseMs;
  failure_class?: string;
  failure_family?: string | null;
};

export type TelemetryEvent = TelemetryInstallEvent | TelemetryDeployEvent;

/** Exact top-level key sets, asserted by the payload tests. */
export const INSTALL_EVENT_KEYS = [
  "event",
  "install_id",
  "sprout_version",
  "runtime",
  "platform",
  "db_provider",
  "capabilities",
  "_timestamp",
  "previews_total",
  "deploys_total",
] as const;

export const DEPLOY_SUCCESS_EVENT_KEYS = [
  "event",
  "install_id",
  "sprout_version",
  "runtime",
  "platform",
  "db_provider",
  "capabilities",
  "_timestamp",
  "outcome",
  "plan",
  "seeded",
  "duration_ms",
  "phase_ms",
] as const;

export const DEPLOY_FAILED_EVENT_KEYS = [
  ...DEPLOY_SUCCESS_EVENT_KEYS,
  "failure_class",
  "failure_family",
] as const;

let cachedVersion: string | null = null;

/** Read from the root package.json at boot, never a literal in source. */
export function sproutVersion(): string {
  cachedVersion ??= (JSON.parse(
    readFileSync(join(import.meta.dir, "../../../../package.json"), "utf8"),
  ) as { version: string }).version;
  return cachedVersion;
}

export function telemetryRuntime(): string {
  return `bun ${Bun.version}`;
}

export function telemetryPlatform(): string {
  return `${process.platform}/${process.arch}`;
}

export function dbProviderFromConfig(config: Config): TelemetryDbProvider {
  return config.postgres ? "postgres" : "sqlite";
}

/** Gateway-level capabilities: mail/TLS/forwardAuth/forge from config. */
export function capabilitiesFromConfig(
  config: Config,
): TelemetryCapability[] {
  const out: TelemetryCapability[] = [];
  if (config.mail) out.push("mail");
  if (config.traefikTls) out.push("tls");
  if (config.traefikForwardAuth) out.push("forwardauth");
  // Data volumes and companion services are manifest-driven, so every
  // gateway supports them regardless of gateway configuration.
  out.push("volumes", "services");
  if (config.gitlabToken !== "") out.push("gitlab");
  if (config.extraGitlabHosts.size > 0) out.push("custom_forge_hosts");
  return out;
}

export function parseTelemetryPlan(raw: string | null | undefined): TelemetryPlan {
  switch (raw) {
    case "seed_resume":
    case "sync_close":
    case "close":
    case "full_replace":
      return raw;
    default:
      return "full_replace";
  }
}

function baseEnvelope(options: {
  installId: string;
  config: Config;
  now: number;
}): TelemetryEnvelope {
  return {
    event: "",
    install_id: options.installId,
    sprout_version: sproutVersion(),
    runtime: telemetryRuntime(),
    platform: telemetryPlatform(),
    db_provider: dbProviderFromConfig(options.config),
    capabilities: capabilitiesFromConfig(options.config),
    _timestamp: new Date(options.now).toISOString(),
  };
}

export function buildInstallEvent(options: {
  installId: string;
  config: Config;
  previewsTotal: number;
  deploysTotal: number;
  now?: number;
}): TelemetryInstallEvent {
  return {
    ...baseEnvelope({
      installId: options.installId,
      config: options.config,
      now: options.now ?? Date.now(),
    }),
    event: "install",
    previews_total: options.previewsTotal,
    deploys_total: options.deploysTotal,
  };
}

export function buildDeployEvent(options: {
  installId: string;
  config: Config;
  outcome: TelemetryOutcome;
  plan: TelemetryPlan;
  seeded: boolean;
  durationMs: number;
  phaseMs: TelemetryPhaseMs;
  failureClass?: string | null;
  failureFamily?: string | null;
  now?: number;
}): TelemetryDeployEvent {
  const event: TelemetryDeployEvent = {
    ...baseEnvelope({
      installId: options.installId,
      config: options.config,
      now: options.now ?? Date.now(),
    }),
    event: "deploy",
    outcome: options.outcome,
    plan: options.plan,
    seeded: options.seeded,
    duration_ms: Math.max(0, Math.round(options.durationMs)),
    phase_ms: phaseMsOnly(options.phaseMs),
  };
  if (options.outcome === "failed") {
    // The stored code is absent only when the row never recorded one.
    event.failure_class = options.failureClass ?? "unknown";
    event.failure_family = options.failureClass == null
      ? "unknown"
      : (options.failureFamily ?? null);
  }
  return event;
}

/** Only the closed-vocabulary phase keys travel; everything else is dropped. */
function phaseMsOnly(phaseMs: TelemetryPhaseMs): TelemetryPhaseMs {
  const out: TelemetryPhaseMs = {};
  for (const phase of ["db", "app", "seed"] as const) {
    const value = phaseMs[phase];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[phase] = Math.max(0, Math.round(value));
    }
  }
  return out;
}
