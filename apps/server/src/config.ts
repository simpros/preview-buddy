import { FORGE_KINDS, type ForgeKind } from "./forge/client.ts";

export const REQUIRED_ENV = [
  "PB_PREVIEW_POSTGRES_URL",
  "PB_PG_USER",
  "PB_TRAEFIK_NETWORK",
  "PB_POSTGRES_NETWORK",
  "PB_REGISTRY_URL",
  "PB_FORGE",
] as const;

export const OPTIONAL_ENV_DEFAULTS = {
  PB_TTL_HOURS: 72,
  PB_SWEEP_MINUTES: 30,
  PB_PREVIEW_PORT_DEFAULT: 8080,
  PB_SEED_TIMEOUT: 180,
  PB_PORT: 7331,
} as const;

export type Config = {
  previewPostgresUrl: string;
  previewPgUser: string;
  traefikNetwork: string;
  postgresNetwork: string;
  registryUrl: string;
  /** Empty string = anonymous registry pull. */
  registryUser: string;
  /** Empty string = anonymous registry pull. */
  registryPassword: string;
  /** Sweep-only forge API token (not used for cloning). Empty until a sweep forge call. */
  forge: ForgeKind;
  /** Empty string allowed at boot; forge API calls fail if still unset. */
  forgeToken: string;
  adminToken?: string;
  ttlHours: number;
  sweepMinutes: number;
  previewPortDefault: number;
  seedTimeout: number;
  port: number;
};

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  return value;
}

function requiredEnv(key: (typeof REQUIRED_ENV)[number]): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw.trim();
}

/** Trimmed env value; missing or blank → "". */
function optionalEnv(key: string): string {
  return process.env[key]?.trim() ?? "";
}

export function loadConfig(): Config {
  const missing = REQUIRED_ENV.filter((key) => {
    const raw = process.env[key];
    return raw === undefined || raw.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  const adminTokenRaw = process.env.PB_ADMIN_TOKEN?.trim();
  const forgeRaw = requiredEnv("PB_FORGE").toLowerCase();
  if (!FORGE_KINDS.includes(forgeRaw as ForgeKind)) {
    throw new Error(
      `Invalid PB_FORGE: must be one of ${FORGE_KINDS.join(", ")}`,
    );
  }

  return {
    previewPostgresUrl: requiredEnv("PB_PREVIEW_POSTGRES_URL"),
    previewPgUser: requiredEnv("PB_PG_USER"),
    traefikNetwork: requiredEnv("PB_TRAEFIK_NETWORK"),
    postgresNetwork: requiredEnv("PB_POSTGRES_NETWORK"),
    registryUrl: requiredEnv("PB_REGISTRY_URL"),
    registryUser: optionalEnv("PB_REGISTRY_USER"),
    registryPassword: optionalEnv("PB_REGISTRY_PASSWORD"),
    forge: forgeRaw as ForgeKind,
    forgeToken: optionalEnv("PB_FORGE_TOKEN"),
    adminToken: adminTokenRaw === "" ? undefined : adminTokenRaw,
    ttlHours: parsePositiveInt(
      "PB_TTL_HOURS",
      process.env.PB_TTL_HOURS,
      OPTIONAL_ENV_DEFAULTS.PB_TTL_HOURS,
    ),
    sweepMinutes: parsePositiveInt(
      "PB_SWEEP_MINUTES",
      process.env.PB_SWEEP_MINUTES,
      OPTIONAL_ENV_DEFAULTS.PB_SWEEP_MINUTES,
    ),
    previewPortDefault: parsePositiveInt(
      "PB_PREVIEW_PORT_DEFAULT",
      process.env.PB_PREVIEW_PORT_DEFAULT,
      OPTIONAL_ENV_DEFAULTS.PB_PREVIEW_PORT_DEFAULT,
    ),
    seedTimeout: parsePositiveInt(
      "PB_SEED_TIMEOUT",
      process.env.PB_SEED_TIMEOUT,
      OPTIONAL_ENV_DEFAULTS.PB_SEED_TIMEOUT,
    ),
    port: parsePositiveInt(
      "PB_PORT",
      process.env.PB_PORT,
      OPTIONAL_ENV_DEFAULTS.PB_PORT,
    ),
  };
}

export function configSummary(config: Config): Record<string, string | number> {
  return {
    previewPostgresUrl: redactUrl(config.previewPostgresUrl),
    previewPgUser: config.previewPgUser,
    traefikNetwork: config.traefikNetwork,
    postgresNetwork: config.postgresNetwork,
    registryUrl: config.registryUrl,
    registryUser: config.registryUser === "" ? "[anonymous]" : config.registryUser,
    registryPassword: config.registryPassword === "" ? "[anonymous]" : "[set]",
    forge: config.forge,
    forgeToken: config.forgeToken === "" ? "[unset]" : "[set]",
    ttlHours: config.ttlHours,
    sweepMinutes: config.sweepMinutes,
    previewPortDefault: config.previewPortDefault,
    seedTimeout: config.seedTimeout,
    port: config.port,
  };
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid url]";
  }
}
