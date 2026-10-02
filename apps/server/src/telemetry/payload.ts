import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  PREVIEW_FAILURE_CODES,
  PREVIEW_FAILURE_FAMILIES,
  PREVIEW_PHASES,
} from "../preview/types.ts";
import type {
  TelemetryDeployOutcome,
  TelemetryPhaseMs,
  TelemetryPlan,
} from "./contract.ts";

export type { TelemetryDeployOutcome } from "./contract.ts";

/**
 * Anonymous install-telemetry payload. The payload is assembled from a fixed
 * field list in this module; the stored lastError/failureFamily strings are
 * validated against the preview vocabularies below, so anything outside the
 * closed sets leaves the box as "unknown" instead of free text.
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

export type TelemetryDeployEvent = TelemetryEnvelope & (
  | {
    event: "deploy";
    outcome: "running";
    plan: TelemetryPlan;
    seeded: boolean;
    duration_ms: number;
    phase_ms: TelemetryPhaseMs;
  }
  | {
    event: "deploy";
    outcome: "failed";
    plan: TelemetryPlan;
    seeded: boolean;
    duration_ms: number;
    phase_ms: TelemetryPhaseMs;
    failure_class: string;
    failure_family: string | null;
  }
);

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
  outcome: Extract<TelemetryDeployOutcome, { outcome: "running" }>;
  now?: number;
}): Extract<TelemetryDeployEvent, { outcome: "running" }>;
export function buildDeployEvent(options: {
  installId: string;
  config: Config;
  outcome: Extract<TelemetryDeployOutcome, { outcome: "failed" }>;
  now?: number;
}): Extract<TelemetryDeployEvent, { outcome: "failed" }>;
export function buildDeployEvent(options: {
  installId: string;
  config: Config;
  outcome: TelemetryDeployOutcome;
  now?: number;
}): TelemetryDeployEvent;
export function buildDeployEvent(options: {
  installId: string;
  config: Config;
  outcome: TelemetryDeployOutcome;
  now?: number;
}): TelemetryDeployEvent {
  const outcome = options.outcome;
  const shared = {
    ...baseEnvelope({
      installId: options.installId,
      config: options.config,
      now: options.now ?? Date.now(),
    }),
    event: "deploy" as const,
    plan: outcome.plan,
    seeded: outcome.seeded,
    duration_ms: Math.max(0, Math.round(outcome.durationMs)),
    phase_ms: phaseMsOnly(outcome.phaseMs),
  };
  if (outcome.outcome === "running") {
    return { ...shared, outcome: "running" as const };
  }
  // The stored code is absent only when the row never recorded one; a code
  // outside the preview vocabulary is untrusted free text, never exported.
  const failureClass = sanitizeFailureClass(outcome.failureClass);
  return {
    ...shared,
    outcome: "failed" as const,
    failure_class: failureClass ?? "unknown",
    failure_family: failureClass == null
      ? "unknown"
      : sanitizeFailureFamily(outcome.failureFamily),
  };
}

const FAILURE_CODES = new Set<string>(PREVIEW_FAILURE_CODES);
const FAILURE_FAMILIES = new Set<string>(PREVIEW_FAILURE_FAMILIES);

function sanitizeFailureClass(code: string | null): string | null {
  if (code == null) return null;
  return FAILURE_CODES.has(code) ? code : null;
}

function sanitizeFailureFamily(family: string | null): string | null {
  if (family == null) return null;
  return FAILURE_FAMILIES.has(family) ? family : "unknown";
}

/** Only the closed-vocabulary phase keys travel; everything else is dropped. */
function phaseMsOnly(phaseMs: TelemetryPhaseMs): TelemetryPhaseMs {
  const out: TelemetryPhaseMs = {};
  for (const phase of PREVIEW_PHASES) {
    const value = phaseMs[phase];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[phase] = Math.max(0, Math.round(value));
    }
  }
  return out;
}
