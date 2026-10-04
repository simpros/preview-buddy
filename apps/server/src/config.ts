import type {
  TraefikForwardAuth,
  TraefikTls,
} from "./app-deployment/labels.ts";
import type { TelemetryState } from "./telemetry/destination.ts";
import { formatOtlpDestination } from "./telemetry/destination.ts";
import type { ConnectionBudget, GovernanceConfig } from "@sprout/preview-env";
import { DEFAULT_MAIL_FROM_DOMAIN, parseDurationMs } from "@sprout/preview-env";
import { GITHUB_HOSTS } from "./forge/kind.ts";
import {
  buildRegistryPullAuth,
  type RegistryPullAuth,
} from "./registry-auth.ts";

export const REQUIRED_ENV = ["SPROUT_TRAEFIK_NETWORK"] as const;

export const POSTGRES_REQUIRED_ENV = [
  "SPROUT_PREVIEW_POSTGRES_URL",
  "SPROUT_PG_HOST",
  "SPROUT_PG_USER",
  "SPROUT_PG_PASSWORD",
  "SPROUT_POSTGRES_NETWORK",
] as const;

export const MAIL_ENV_KEYS = [
  "SPROUT_MAIL_HOST",
  "SPROUT_MAIL_PORT",
  "SPROUT_MAIL_USER",
  "SPROUT_MAIL_PASSWORD",
  "SPROUT_MAIL_SECURE",
  "SPROUT_MAIL_NETWORK",
  "SPROUT_MAIL_UI_URL",
  "SPROUT_MAIL_FROM_DOMAIN",
] as const;

export const PREVIEW_AUTH_ENV_KEYS = [
  "SPROUT_PREVIEW_AUTH_SECRET",
  "SPROUT_PREVIEW_AUTH_ADDRESS",
] as const;

export const OPTIONAL_ENV_DEFAULTS = {
  SPROUT_PG_PORT: 5432,
  SPROUT_MAIL_PORT: 1025,
  SPROUT_TTL_HOURS: 72,
  SPROUT_SWEEP_CRON: "*/30 * * * *",
  SPROUT_TELEMETRY: "on",
  SPROUT_PREVIEW_PORT_DEFAULT: 8080,
  SPROUT_SEED_TIMEOUT: 180,
  SPROUT_PORT: 7331,
} as const;

export const OPTIONAL_STRING_ENV = [
  "SPROUT_REGISTRY_USER",
  "SPROUT_REGISTRY_PASSWORD",
  "SPROUT_REGISTRY_AUTHS_JSON",
  "SPROUT_GITHUB_TOKEN",
  "SPROUT_GITLAB_TOKEN",
  "SPROUT_FORGE_HOSTS",
  "SPROUT_TRAEFIK_ENTRYPOINTS",
  "SPROUT_TRAEFIK_CERTRESOLVER",
  "SPROUT_TRAEFIK_WILDCARD_TLS",
  "SPROUT_TRAEFIK_MIDDLEWARES",
  "SPROUT_FORWARDAUTH_ADDRESS",
  "SPROUT_TELEMETRY_ENDPOINT",
  "SPROUT_TELEMETRY_AUTH",
  "SPROUT_OTLP_ENDPOINT",
  "SPROUT_OTLP_HEADERS",
] as const;

export const DASHBOARD_ENV_KEYS = [
  "SPROUT_DASHBOARD_ENABLED",
  "SPROUT_DASHBOARD_HOST",
  "SPROUT_DASHBOARD_AUTH",
  "SPROUT_DASHBOARD_USER",
  "SPROUT_DASHBOARD_PASSWORD",
] as const;

export const GOVERNANCE_ENV_KEYS = [
  "SPROUT_PREVIEW_TTL",
  "SPROUT_PREVIEW_IDLE_TEARDOWN",
  "SPROUT_MAX_PREVIEWS_PER_REPO",
  "SPROUT_MAX_PREVIEWS",
  "SPROUT_PREVIEW_MAX_DB_CONNECTIONS",
  "SPROUT_POSTGRES_MAX_CONNECTIONS",
] as const;

export const GATEWAY_ENV_DOC_KEYS: readonly string[] = [
  ...REQUIRED_ENV,
  ...POSTGRES_REQUIRED_ENV,
  ...MAIL_ENV_KEYS,
  ...PREVIEW_AUTH_ENV_KEYS,
  ...Object.keys(OPTIONAL_ENV_DEFAULTS),
  ...OPTIONAL_STRING_ENV,
  ...DASHBOARD_ENV_KEYS,
  ...GOVERNANCE_ENV_KEYS,
  "SPROUT_ADMIN_TOKEN",
  "SPROUT_STATE_DB_PATH",
  "SPROUT_ADMIN_TOKEN_PATH",
];

export type PostgresConfig = {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  network: string;
};

export type MailConfig = {
  host: string;
  port: number;
  user?: string;
  password?: string;
  secure: boolean;
  network?: string;
  uiUrl?: string;
  fromDomain: string;
};

export type PreviewAuthConfig = {
  secret: string;
  /** In-network forwardAuth address Traefik calls, e.g. http://gateway:7331/v1/internal/preview-auth. */
  address: string;
};

export type DashboardConfig = {
  enabled: boolean;
  host?: string;
  user: string;
  password: string;
};

export type OtlpConfig = {
  /** Verbatim OTLP/HTTP traces URL; empty means tracing is off. */
  endpoint: string;
  /** Verbatim export headers; never logged. */
  headers: Record<string, string>;
};

export type Config = {
  /** Absent on sqlite-only gateways; all-or-nothing (partial fails boot). */
  postgres?: PostgresConfig;
  /** Absent when no SPROUT_MAIL_* is set; host enables, rest default. */
  mail?: MailConfig;
  /** Absent unless the preview-auth group is set; all-or-nothing (partial fails boot). */
  previewAuth?: PreviewAuthConfig;
  dashboard: DashboardConfig;
  traefikNetwork: string;
  registryPullAuth: RegistryPullAuth;
  githubToken: string;
  gitlabToken: string;
  extraGitlabHosts: ReadonlySet<string>;
  adminToken?: string;
  ttlHours: number;
  /** SPROUT_TTL_HOURS as ms, derived once here so read and sweep surfaces
   * share one bound without converting units themselves. */
  legacyTtlMs: number;
  sweepCron: string;
  previewPortDefault: number;
  seedTimeout: number;
  port: number;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
  /** The enablement decision, resolved once at load; off always names its reason. */
  telemetry: TelemetryState;
  /** Operator-owned trace export; active exactly when endpoint is set. */
  otlp: OtlpConfig;
  /** Preview TTL/idle/cap/budget policy: null means off. Nested so passing
   * the whole Config never silently satisfies a GovernanceConfig. */
  governance: GovernanceConfig;
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

/** SPROUT_TTL_HOURS as ms, derived once at load so read and sweep surfaces
 * share one bound without converting units themselves. */
function hoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

/** Gateway-level duration: empty/off means unbounded, otherwise a duration. */
export function parseGatewayDurationMs(
  envName: string,
  raw: string | undefined,
): number | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed.toLowerCase() === "off") return null;
  const ms = parseDurationMs(trimmed);
  if (ms === null) {
    throw new Error(
      `Invalid ${envName}: expected a duration (e.g. 7d, 2h, 30m) or off, got ${JSON.stringify(raw ?? "")}`,
    );
  }
  return ms;
}

/** Gateway-level cap: empty/off means unbounded, otherwise a positive int. */
export function parseGatewayCap(
  envName: string,
  raw: string | undefined,
): number | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed.toLowerCase() === "off") return null;
  // Empty/off returned above, so trimmed is always a value here and the
  // default never fires; the positive-int check stays in one place.
  return parsePositiveInt(envName, trimmed, 0);
}

/** Connection budget is a pair or absent: one half without the other
 * fails boot instead of silently enforcing nothing. */
function parseConnectionBudget(): ConnectionBudget | null {
  const perPreview = parseGatewayCap(
    "SPROUT_PREVIEW_MAX_DB_CONNECTIONS",
    process.env.SPROUT_PREVIEW_MAX_DB_CONNECTIONS,
  );
  const ceiling = parseGatewayCap(
    "SPROUT_POSTGRES_MAX_CONNECTIONS",
    process.env.SPROUT_POSTGRES_MAX_CONNECTIONS,
  );
  if (perPreview === null && ceiling === null) return null;
  if (perPreview === null || ceiling === null) {
    const missing =
      perPreview === null
        ? "SPROUT_PREVIEW_MAX_DB_CONNECTIONS"
        : "SPROUT_POSTGRES_MAX_CONNECTIONS";
    throw new Error(
      `Incomplete preview connection budget: missing ${missing} (set both or neither)`,
    );
  }
  return { perPreview, ceiling };
}

function parseSweepCron(
  raw: string | undefined,
  defaultValue: string,
): string {
  const trimmed = raw?.trim() ?? "";
  const schedule = trimmed === "" ? defaultValue : trimmed;
  try {
    Bun.cron(schedule, () => {}).stop();
  } catch (error) {
    throw new Error(
      `Invalid SPROUT_SWEEP_CRON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return schedule;
}

function parseBooleanToken(
  normalized: string,
  trueTokens: readonly string[],
  falseTokens: readonly string[],
): boolean | undefined {
  if (trueTokens.includes(normalized)) return true;
  if (falseTokens.includes(normalized)) return false;
  return undefined;
}

const BOOLEAN_TRUE_TOKENS = ["on", "1", "true", "yes"];
const BOOLEAN_FALSE_TOKENS = ["off", "0", "false", "no"];

function parseBooleanEnv(
  raw: string | undefined,
  options: {
    trueTokens: readonly string[];
    falseTokens: readonly string[];
    /** Substituted when raw is blank; a blank default means false. */
    defaultRaw?: string;
    error: string;
  },
): boolean {
  const trimmed = raw?.trim() ?? "";
  const effective =
    trimmed === "" ? (options.defaultRaw?.trim() ?? "") : trimmed;
  if (effective === "") return false;
  const parsed = parseBooleanToken(
    effective.toLowerCase(),
    options.trueTokens,
    options.falseTokens,
  );
  if (parsed === undefined) throw new Error(options.error);
  return parsed;
}

function parseTelemetryFlag(
  raw: string | undefined,
  defaultValue: string,
): boolean {
  return parseBooleanEnv(raw, {
    trueTokens: BOOLEAN_TRUE_TOKENS,
    falseTokens: BOOLEAN_FALSE_TOKENS,
    defaultRaw: defaultValue,
    error:
      "Invalid SPROUT_TELEMETRY: must be a boolean (on/off, true/false, 1/0, yes/no)",
  });
}

function parseTelemetryDestination(): {
  endpoint: string;
  auth: string;
} {
  const endpoint = optionalEnv("SPROUT_TELEMETRY_ENDPOINT");
  const auth = optionalEnv("SPROUT_TELEMETRY_AUTH");
  if (endpoint === "" && auth === "") return { endpoint: "", auth: "" };
  if (endpoint === "" || auth === "") {
    const missing =
      endpoint === "" ? "SPROUT_TELEMETRY_ENDPOINT" : "SPROUT_TELEMETRY_AUTH";
    throw new Error(
      `SPROUT_TELEMETRY_ENDPOINT and SPROUT_TELEMETRY_AUTH must both be set (or both empty): missing ${missing}`,
    );
  }
  return { endpoint, auth };
}

/** Split a comma-separated env list, trimming entries and dropping empties. */
function splitListEntries(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const out: string[] = [];
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (entry !== "") out.push(entry);
  }
  return out;
}

export function parseOtlpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of splitListEntries(raw)) {
    const sep = entry.indexOf("=");
    if (sep <= 0) {
      throw new Error(
        `Invalid SPROUT_OTLP_HEADERS entry "${entry}": expected name=value`,
      );
    }
    const name = entry.slice(0, sep).trim();
    const value = entry.slice(sep + 1);
    if (name === "") {
      throw new Error(
        `Invalid SPROUT_OTLP_HEADERS entry "${entry}": expected name=value`,
      );
    }
    out[name] = value;
  }
  return out;
}

function parseOtlpConfig(): OtlpConfig {
  const endpoint = optionalEnv("SPROUT_OTLP_ENDPOINT");
  const headersRaw = optionalEnv("SPROUT_OTLP_HEADERS");
  if (endpoint === "") {
    if (headersRaw !== "") {
      throw new Error(
        "SPROUT_OTLP_HEADERS is set but SPROUT_OTLP_ENDPOINT is empty: set both or neither",
      );
    }
    return { endpoint: "", headers: {} };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      "Invalid SPROUT_OTLP_ENDPOINT: must be an absolute http(s) URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Invalid SPROUT_OTLP_ENDPOINT: must be an absolute http(s) URL",
    );
  }
  return { endpoint, headers: parseOtlpHeaders(headersRaw) };
}

function requiredEnv(key: (typeof REQUIRED_ENV)[number]): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw.trim();
}

function optionalEnv(
  key:
    | (typeof OPTIONAL_STRING_ENV)[number]
    | (typeof POSTGRES_REQUIRED_ENV)[number]
    | (typeof MAIL_ENV_KEYS)[number]
    | (typeof PREVIEW_AUTH_ENV_KEYS)[number]
    | (typeof DASHBOARD_ENV_KEYS)[number],
): string {
  return process.env[key]?.trim() ?? "";
}

function parseMailSecure(raw: string): boolean {
  return parseBooleanEnv(raw, {
    trueTokens: ["1", "true", "yes"],
    falseTokens: ["0", "false", "no"],
    error:
      "Invalid SPROUT_MAIL_SECURE: must be a boolean (true/false, 1/0, yes/no)",
  });
}

/** The enablement decision, computed once so off always names its reason. */
export function resolveTelemetryState(options: {
  flag: boolean;
  doNotTrack: boolean;
  endpoint: string;
  auth: string;
}): TelemetryState {
  if (!options.flag) return { enabled: false, reason: "SPROUT_TELEMETRY" };
  if (options.doNotTrack) return { enabled: false, reason: "DO_NOT_TRACK" };
  return { enabled: true, endpoint: options.endpoint, auth: options.auth };
}

/** Mail is host-enabled: any SPROUT_MAIL_* without a host fails boot naming the host. */
function parseMailConfig(): MailConfig | undefined {
  const host = optionalEnv("SPROUT_MAIL_HOST");
  const portRaw = optionalEnv("SPROUT_MAIL_PORT");
  const user = optionalEnv("SPROUT_MAIL_USER");
  const password = optionalEnv("SPROUT_MAIL_PASSWORD");
  const secureRaw = optionalEnv("SPROUT_MAIL_SECURE");
  const network = optionalEnv("SPROUT_MAIL_NETWORK");
  const uiUrl = optionalEnv("SPROUT_MAIL_UI_URL");
  const fromDomainRaw = optionalEnv("SPROUT_MAIL_FROM_DOMAIN");
  // Compose passes empty defaults for every mail key, so any set value is
  // operator intent; OPTIONAL_ENV_DEFAULTS/DEFAULT_MAIL_FROM_DOMAIN stay
  // the single defaulting home below.
  const anySet = MAIL_ENV_KEYS.some((key) => optionalEnv(key) !== "");
  if (!anySet) return undefined;
  if (host === "") {
    throw new Error(
      "Incomplete mail configuration: missing SPROUT_MAIL_HOST",
    );
  }
  return {
    host,
    port: parsePositiveInt(
      "SPROUT_MAIL_PORT",
      portRaw === "" ? undefined : portRaw,
      OPTIONAL_ENV_DEFAULTS.SPROUT_MAIL_PORT,
    ),
    ...(user === "" ? {} : { user }),
    ...(password === "" ? {} : { password }),
    secure: parseMailSecure(secureRaw),
    ...(network === "" ? {} : { network }),
    ...(uiUrl === "" ? {} : { uiUrl }),
    fromDomain: fromDomainRaw === "" ? DEFAULT_MAIL_FROM_DOMAIN : fromDomainRaw,
  };
}

/** Preview link-auth is all-or-nothing: partial sets fail boot instead of limping. */
function parsePreviewAuthConfig(): PreviewAuthConfig | undefined {
  const secret = optionalEnv("SPROUT_PREVIEW_AUTH_SECRET");
  const address = optionalEnv("SPROUT_PREVIEW_AUTH_ADDRESS");
  if (secret === "" && address === "") return undefined;
  const missing: string[] = [];
  if (secret === "") missing.push("SPROUT_PREVIEW_AUTH_SECRET");
  if (address === "") missing.push("SPROUT_PREVIEW_AUTH_ADDRESS");
  if (missing.length > 0) {
    throw new Error(
      `Incomplete preview auth configuration: missing ${missing.join(", ")}`,
    );
  }
  return { secret, address };
}

function parseTraefikWildcardTls(): boolean {
  return parseBooleanEnv(process.env.SPROUT_TRAEFIK_WILDCARD_TLS, {
    trueTokens: BOOLEAN_TRUE_TOKENS,
    falseTokens: BOOLEAN_FALSE_TOKENS,
    error:
      "Invalid SPROUT_TRAEFIK_WILDCARD_TLS: must be a boolean (true/false, 1/0, yes/no, on/off)",
  });
}

function parseTraefikTls(): TraefikTls | undefined {
  const entrypoints = optionalEnv("SPROUT_TRAEFIK_ENTRYPOINTS");
  const wildcard = parseTraefikWildcardTls();
  if (entrypoints === "") {
    if (wildcard) {
      throw new Error(
        "Incomplete Traefik wildcard TLS configuration: missing SPROUT_TRAEFIK_ENTRYPOINTS (wildcard TLS needs HTTPS routers)",
      );
    }
    return undefined;
  }
  const certResolver = optionalEnv("SPROUT_TRAEFIK_CERTRESOLVER");
  if (wildcard && certResolver === "") {
    throw new Error(
      "Incomplete Traefik wildcard TLS configuration: missing SPROUT_TRAEFIK_CERTRESOLVER (wildcard certificates require DNS-01, never HTTP-01)",
    );
  }
  if (certResolver === "") {
    return { entrypoints };
  }
  return wildcard
    ? { entrypoints, certResolver, wildcard: true }
    : { entrypoints, certResolver };
}

function parseTraefikForwardAuth(): TraefikForwardAuth | undefined {
  const middleware = optionalEnv("SPROUT_TRAEFIK_MIDDLEWARES");
  const address = optionalEnv("SPROUT_FORWARDAUTH_ADDRESS");
  if (middleware === "" && address === "") return undefined;
  if (middleware === "" || address === "") {
    throw new Error(
      "SPROUT_TRAEFIK_MIDDLEWARES and SPROUT_FORWARDAUTH_ADDRESS must both be set (or both empty)",
    );
  }
  if (middleware.includes(",")) {
    throw new Error(
      "SPROUT_TRAEFIK_MIDDLEWARES must be a single Traefik middleware name (no commas)",
    );
  }
  return { middleware, address };
}

function parseDashboardEnabled(raw: string | undefined): boolean {
  return parseBooleanEnv(raw, {
    trueTokens: BOOLEAN_TRUE_TOKENS,
    falseTokens: BOOLEAN_FALSE_TOKENS,
    error:
      "Invalid SPROUT_DASHBOARD_ENABLED: must be a boolean (true/false, 1/0, yes/no)",
  });
}

/** Opt-in read-only preview list. Enabled demands basic-auth credentials. */
function parseDashboardConfig(): DashboardConfig {
  const enabled = parseDashboardEnabled(process.env.SPROUT_DASHBOARD_ENABLED);
  const auth = optionalEnv("SPROUT_DASHBOARD_AUTH");
  if (auth !== "" && auth !== "basic") {
    throw new Error(
      'Invalid SPROUT_DASHBOARD_AUTH: must be "basic" (the only protection model)',
    );
  }
  if (!enabled) {
    return { enabled: false, user: "", password: "" };
  }
  const user = optionalEnv("SPROUT_DASHBOARD_USER");
  const password = optionalEnv("SPROUT_DASHBOARD_PASSWORD");
  const missing: string[] = [];
  if (user === "") missing.push("SPROUT_DASHBOARD_USER");
  if (password === "") missing.push("SPROUT_DASHBOARD_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `Incomplete dashboard configuration: missing ${missing.join(", ")}`,
    );
  }
  const host = optionalEnv("SPROUT_DASHBOARD_HOST");
  return {
    enabled: true,
    ...(host === "" ? {} : { host }),
    user,
    password,
  };
}

export function parseExtraGitlabHosts(raw: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of splitListEntries(raw)) {
    const sep = entry.includes("=") ? "=" : entry.includes(":") ? ":" : null;
    if (!sep) {
      throw new Error(
        `Invalid SPROUT_FORGE_HOSTS entry "${entry}": expected host=gitlab`,
      );
    }
    const [hostRaw, kindRaw] = entry.split(sep, 2);
    const host = hostRaw?.trim().toLowerCase() ?? "";
    const kind = kindRaw?.trim().toLowerCase() ?? "";
    if (!host || kind !== "gitlab") {
      throw new Error(
        `Invalid SPROUT_FORGE_HOSTS entry "${entry}": expected host=gitlab (custom hosts → GitLab only; github.com is inferred)`,
      );
    }
    if (GITHUB_HOSTS.has(host)) {
      throw new Error(
        `Invalid SPROUT_FORGE_HOSTS entry "${entry}": ${host} is a built-in GitHub host and cannot be remapped`,
      );
    }
    out.add(host);
  }
  return out;
}

/** Postgres is all-or-nothing: partial sets fail boot instead of limping. */
function parsePostgresConfig(): PostgresConfig | undefined {
  const values = {
    url: optionalEnv("SPROUT_PREVIEW_POSTGRES_URL"),
    host: optionalEnv("SPROUT_PG_HOST"),
    user: optionalEnv("SPROUT_PG_USER"),
    password: optionalEnv("SPROUT_PG_PASSWORD"),
    network: optionalEnv("SPROUT_POSTGRES_NETWORK"),
  };
  const set = (
    Object.entries(values) as [keyof typeof values, string][]
  ).filter(([, value]) => value !== "");
  if (set.length === 0) return undefined;
  if (set.length !== POSTGRES_REQUIRED_ENV.length) {
    const have = new Set(set.map(([key]) => key));
    const keyFor: Record<keyof typeof values, string> = {
      url: "SPROUT_PREVIEW_POSTGRES_URL",
      host: "SPROUT_PG_HOST",
      user: "SPROUT_PG_USER",
      password: "SPROUT_PG_PASSWORD",
      network: "SPROUT_POSTGRES_NETWORK",
    };
    const missing = (Object.keys(values) as (keyof typeof values)[])
      .filter((key) => !have.has(key))
      .map((key) => keyFor[key]);
    throw new Error(
      `Incomplete Postgres configuration: missing ${missing.join(", ")}`,
    );
  }
  return {
    ...values,
    port: parsePositiveInt(
      "SPROUT_PG_PORT",
      process.env.SPROUT_PG_PORT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PG_PORT,
    ),
  };
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

  const adminTokenRaw = process.env.SPROUT_ADMIN_TOKEN?.trim();
  const registryPullAuth = buildRegistryPullAuth({
    authsJson: optionalEnv("SPROUT_REGISTRY_AUTHS_JSON"),
    legacyUser: optionalEnv("SPROUT_REGISTRY_USER"),
    legacyPassword: optionalEnv("SPROUT_REGISTRY_PASSWORD"),
  });

  const telemetryFlag = parseTelemetryFlag(
    process.env.SPROUT_TELEMETRY,
    OPTIONAL_ENV_DEFAULTS.SPROUT_TELEMETRY,
  );
  const doNotTrack = (process.env.DO_NOT_TRACK?.trim() ?? "") === "1";
  const telemetryDestination = parseTelemetryDestination();
  const telemetry = resolveTelemetryState({
    flag: telemetryFlag,
    doNotTrack,
    endpoint: telemetryDestination.endpoint,
    auth: telemetryDestination.auth,
  });

  const ttlHours = parsePositiveInt(
    "SPROUT_TTL_HOURS",
    process.env.SPROUT_TTL_HOURS,
    OPTIONAL_ENV_DEFAULTS.SPROUT_TTL_HOURS,
  );

  return {
    postgres: parsePostgresConfig(),
    mail: parseMailConfig(),
    previewAuth: parsePreviewAuthConfig(),
    dashboard: parseDashboardConfig(),
    traefikNetwork: requiredEnv("SPROUT_TRAEFIK_NETWORK"),
    registryPullAuth,
    githubToken: optionalEnv("SPROUT_GITHUB_TOKEN"),
    gitlabToken: optionalEnv("SPROUT_GITLAB_TOKEN"),
    extraGitlabHosts: parseExtraGitlabHosts(
      optionalEnv("SPROUT_FORGE_HOSTS"),
    ),
    adminToken: adminTokenRaw === "" ? undefined : adminTokenRaw,
    ttlHours,
    legacyTtlMs: hoursToMs(ttlHours),
    sweepCron: parseSweepCron(
      process.env.SPROUT_SWEEP_CRON,
      OPTIONAL_ENV_DEFAULTS.SPROUT_SWEEP_CRON,
    ),
    previewPortDefault: parsePositiveInt(
      "SPROUT_PREVIEW_PORT_DEFAULT",
      process.env.SPROUT_PREVIEW_PORT_DEFAULT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PREVIEW_PORT_DEFAULT,
    ),
    seedTimeout: parsePositiveInt(
      "SPROUT_SEED_TIMEOUT",
      process.env.SPROUT_SEED_TIMEOUT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_SEED_TIMEOUT,
    ),
    port: parsePositiveInt(
      "SPROUT_PORT",
      process.env.SPROUT_PORT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PORT,
    ),
    traefikTls: parseTraefikTls(),
    traefikForwardAuth: parseTraefikForwardAuth(),
    telemetry,
    otlp: parseOtlpConfig(),
    governance: {
      previewTtlMs: parseGatewayDurationMs(
        "SPROUT_PREVIEW_TTL",
        process.env.SPROUT_PREVIEW_TTL,
      ),
      previewIdleMs: parseGatewayDurationMs(
        "SPROUT_PREVIEW_IDLE_TEARDOWN",
        process.env.SPROUT_PREVIEW_IDLE_TEARDOWN,
      ),
      maxPreviewsPerRepo: parseGatewayCap(
        "SPROUT_MAX_PREVIEWS_PER_REPO",
        process.env.SPROUT_MAX_PREVIEWS_PER_REPO,
      ),
      maxPreviews: parseGatewayCap(
        "SPROUT_MAX_PREVIEWS",
        process.env.SPROUT_MAX_PREVIEWS,
      ),
      connectionBudget: parseConnectionBudget(),
    },
  };
}

/** Loud boot warning when the gateway runs unbounded. */
export function governanceUnboundedWarning(config: Config): string | null {
  if (
    config.governance.previewTtlMs === null &&
    config.governance.previewIdleMs === null &&
    config.governance.maxPreviewsPerRepo === null &&
    config.governance.maxPreviews === null
  ) {
    return (
      "preview governance is unbounded (SPROUT_PREVIEW_TTL, " +
      "SPROUT_PREVIEW_IDLE_TEARDOWN, SPROUT_MAX_PREVIEWS_PER_REPO and " +
      "SPROUT_MAX_PREVIEWS are all off): previews live until PR close"
    );
  }
  return null;
}

export function missingPostgresEnv(
  postgres: PostgresConfig | undefined,
): string[] {
  return postgres ? [] : [...POSTGRES_REQUIRED_ENV];
}

export function isPostgresConfigured(
  postgres: PostgresConfig | undefined,
): boolean {
  return postgres !== undefined;
}

export function postgresNotConfiguredDetail(
  postgres: PostgresConfig | undefined,
  repo: string,
): string {
  const missing = missingPostgresEnv(postgres);
  return (
    `repo ${repo} declares db.provider postgres but the gateway has no Postgres configured: ` +
    `missing ${missing.join(", ")}`
  );
}

export function mailNotConfiguredDetail(repo: string): string {
  return (
    `repo ${repo} declares mail enabled but the gateway has no mail configured: ` +
    `missing SPROUT_MAIL_HOST`
  );
}

export function previewAuthNotConfiguredDetail(repo: string): string {
  return (
    `repo ${repo} declares preview.auth link but the gateway has no preview auth configured: ` +
    `missing SPROUT_PREVIEW_AUTH_SECRET`
  );
}

export function configSummary(config: Config): Record<string, string | number> {
  const pg = config.postgres;
  const mail = config.mail;
  const previewAuth = config.previewAuth;
  return {
    previewPostgresUrl: pg ? redactUrl(pg.url) : "[unset]",
    previewPgHost: pg ? pg.host : "[unset]",
    previewPgPort: pg ? pg.port : "[unset]",
    previewPgUser: pg ? pg.user : "[unset]",
    previewPgPassword: pg ? "[set]" : "[empty]",
    traefikNetwork: config.traefikNetwork,
    postgresNetwork: pg ? pg.network : "[unset]",
    previewMailHost: mail ? mail.host : "[unset]",
    previewMailPort: mail ? mail.port : "[unset]",
    previewMailUser: mail?.user ?? "[unset]",
    previewMailSecure: mail ? String(mail.secure) : "[unset]",
    mailNetwork: mail?.network ?? "[unset]",
    mailUiUrl: mail?.uiUrl ?? "[unset]",
    mailFromDomain: mail ? mail.fromDomain : "[unset]",
    previewAuthSecret: previewAuth ? "[set]" : "[unset]",
    previewAuthAddress: previewAuth ? previewAuth.address : "[unset]",
    dashboardEnabled: config.dashboard.enabled ? "true" : "false",
    dashboardHost: config.dashboard.host ?? "[unset]",
    dashboardUser: config.dashboard.user === "" ? "[unset]" : "[set]",
    registryPullAuthHosts: config.registryPullAuth.byHost.size,
    registryPullAuthFallback: config.registryPullAuth.fallback
      ? "[set]"
      : "[unset]",
    githubToken: config.githubToken === "" ? "[unset]" : "[set]",
    gitlabToken: config.gitlabToken === "" ? "[unset]" : "[set]",
    extraGitlabHosts: config.extraGitlabHosts.size,
    ttlHours: config.ttlHours,
    previewTtlMs: config.governance.previewTtlMs ?? "[off]",
    previewIdleMs: config.governance.previewIdleMs ?? "[off]",
    maxPreviewsPerRepo: config.governance.maxPreviewsPerRepo ?? "[off]",
    maxPreviews: config.governance.maxPreviews ?? "[off]",
    connectionBudget: connectionBudgetSummary(config.governance.connectionBudget),
    sweepCron: config.sweepCron,
    previewPortDefault: config.previewPortDefault,
    seedTimeout: config.seedTimeout,
    port: config.port,
    traefikTls: formatTraefikTlsSummary(config.traefikTls),
    traefikForwardAuth: formatTraefikForwardAuthSummary(
      config.traefikForwardAuth,
    ),
    telemetryAuth: telemetryAuthSummary(config.telemetry),
    traces: formatOtlpDestination(config.otlp.endpoint),
    otlpHeaders: otlpHeadersSummary(config.otlp),
  };
}

function otlpHeadersSummary(otlp: OtlpConfig): string {
  return Object.keys(otlp.headers).length > 0 ? "[set]" : "[empty]";
}

function connectionBudgetSummary(budget: ConnectionBudget | null): string {
  if (budget === null) return "[off]";
  return `${budget.perPreview}x/ceiling-${budget.ceiling}`;
}

function telemetryAuthSummary(telemetry: TelemetryState): string {
  if (!telemetry.enabled || telemetry.auth === "") return "[empty]";
  return "[set]";
}

function formatTraefikTlsSummary(tls: TraefikTls | undefined): string {
  if (!tls) return "[unset]";
  const base =
    tls.certResolver === undefined
      ? tls.entrypoints
      : `${tls.entrypoints} (certresolver=${tls.certResolver})`;
  if (tls.wildcard !== true) return base;
  return `${tls.entrypoints} (certresolver=${tls.certResolver}, wildcard)`;
}

/** Wildcard mode needs a DNS-01 resolver, which sprout cannot observe. */
export function traefikWildcardWarning(config: Config): string | null {
  if (config.traefikTls?.wildcard !== true) return null;
  return (
    "preview wildcard TLS is on (SPROUT_TRAEFIK_WILDCARD_TLS): " +
    "SPROUT_TRAEFIK_CERTRESOLVER must be a DNS-01 resolver — " +
    'see docs/operator-deploy.md § "Wildcard preview certificate (DNS-01)"'
  );
}

function formatTraefikForwardAuthSummary(
  policy: TraefikForwardAuth | undefined,
): string {
  if (!policy) return "[unset]";
  return `${policy.middleware} → ${policy.address}`;
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
