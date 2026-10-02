import type { GovernanceConfig } from "@sprout/preview-env";

/** All-bounds-off governance: previews live until PR close. */
export function offGovernanceConfig(): GovernanceConfig {
  return {
    previewTtlMs: null,
    previewIdleMs: null,
    maxPreviews: null,
    maxPreviewsPerRepo: null,
    previewMaxDbConnections: null,
    postgresMaxConnections: null,
  };
}

/** Governance with overrides over the all-off default. */
export function governanceConfig(
  overrides: Partial<GovernanceConfig> = {},
): GovernanceConfig {
  return { ...offGovernanceConfig(), ...overrides };
}
