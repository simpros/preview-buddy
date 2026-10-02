import type { DbProvider } from "./db.ts";
import { envProviderMismatch, parsePreviewEnvMap } from "./env-keys.ts";
import type {
  CanonicalEnvKey,
  PreviewEnvIssue,
  PreviewEnvMap,
} from "./env-keys.ts";

export {
  authSpecIssueMessage,
  parsePreviewAuthSpec,
  previewAuthMode,
  type PreviewAuthMode,
  type PreviewAuthSpec,
} from "./auth.ts";

export { OWNER_ENV_KEYS, PREVIEW_ENV_KEYS } from "./env-keys.ts";

export type {
  CanonicalEnvKey,
  MailEnvKey,
  OwnerEnvKey,
  PreviewEnvKey,
  PreviewEnvMap,
} from "./env-keys.ts";

type EnvProviderIssue = {
  code: "env_requires_provider";
  key: CanonicalEnvKey;
  home: DbProvider;
};

/** Parse plus provider-scope check: the single entry both CLI and server call. */
export function parsePreviewEnvForProvider(
  raw: Record<string, unknown> | undefined,
  provider: DbProvider,
):
  | { ok: true; value: PreviewEnvMap | undefined }
  | { ok: false; issue: PreviewEnvIssue | EnvProviderIssue } {
  const parsed = parsePreviewEnvMap(raw);
  if (!parsed.ok) return parsed;
  const mismatch = envProviderMismatch(parsed.value, provider);
  if (mismatch) {
    return {
      ok: false,
      issue: { code: "env_requires_provider", ...mismatch },
    };
  }
  return parsed;
}

export {
  resolveHostnameValue,
  validateHostname,
  validateHostnameValue,
  type HostnameIssue,
} from "./hostname.ts";

export {
  DEFAULT_HEALTH,
  resolveHealthSpec,
  type HealthIssue,
  type HealthRequest,
  type HealthSpec,
} from "./health.ts";

export {
  dbRolesIssueMessage,
  dbSpecIssueMessage,
  defaultDbSpec,
  isDbProvider,
  normalizeDbSpec,
  parseDbSpec,
  requiresDatabase,
  resolveDbRoles,
  seedRequiresDatabaseMessage,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbRolesMode,
  type DbSpec,
} from "./db.ts";

export {
  dataVolumeName,
  parseDataVolumeName,
  parseSqliteVolumeName,
  sqliteVolumeName,
  type DataVolumeRef,
} from "./naming.ts";

export {
  labelIssueMessage,
  parseLabelMap,
  type PreviewLabels,
} from "./labels.ts";

export {
  copyServiceExtras,
  ENV_TARGET_RE,
  isServicePort,
  MAX_SERVICES,
  parseServiceEnvMap,
  SERVICE_NAME_RE,
  type PreviewServiceSpec,
  type ServiceFields,
} from "./services.ts";

export {
  parsePreviewVolumes,
  previewVolumeIssueMessage,
  type PreviewVolumeIssue,
} from "./volumes.ts";

export {
  governanceIssueMessage,
  parseDurationMs,
  parsePreviewGovernanceField,
  type EffectiveGovernanceMs,
  type GovernanceConfig,
  type GovernanceManifest,
} from "./governance.ts";

export {
  DEFAULT_MAIL_FROM_DOMAIN,
  deriveMailFromName,
  mailIntent,
  mailSpecIssueMessage,
  parseMailSpec,
  resolveMailIdentity,
  type MailIdentity,
  type MailSpec,
} from "./mail.ts";
