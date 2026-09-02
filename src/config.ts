export const REQUIRED_ENV = [
  "PB_PREVIEW_POSTGRES_URL",
  "PB_TRAEFIK_NETWORK",
  "PB_POSTGRES_NETWORK",
  "PB_REGISTRY_URL",
  "PB_REGISTRY_USER",
  "PB_REGISTRY_PASSWORD",
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
  traefikNetwork: string;
  postgresNetwork: string;
  registryUrl: string;
  registryUser: string;
  registryPassword: string;
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

export function loadConfig(): Config {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    previewPostgresUrl: process.env.PB_PREVIEW_POSTGRES_URL!,
    traefikNetwork: process.env.PB_TRAEFIK_NETWORK!,
    postgresNetwork: process.env.PB_POSTGRES_NETWORK!,
    registryUrl: process.env.PB_REGISTRY_URL!,
    registryUser: process.env.PB_REGISTRY_USER!,
    registryPassword: process.env.PB_REGISTRY_PASSWORD!,
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
    traefikNetwork: config.traefikNetwork,
    postgresNetwork: config.postgresNetwork,
    registryUrl: config.registryUrl,
    registryUser: config.registryUser,
    registryPassword: config.registryPassword ? "[set]" : "[unset]",
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
