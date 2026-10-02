import type { HealthSpec, PreviewAuthSpec, PreviewLabels } from "@sprout/preview-env";
import type {
  PreviewAppOps,
  PreviewServiceSpec,
} from "../app-deployment/ops.ts";
import type {
  TraefikForwardAuth,
  TraefikTls,
} from "../app-deployment/labels.ts";
import type { SeedImageSpec } from "../app-deployment/seed.ts";
import type { PreviewAuthConfig } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewDataVolumes } from "./data-volumes.ts";
import type { PreviewDbPlan } from "./runtime.ts";

export type PreviewStatus =
  | "provisioning"
  | "starting"
  | "seeding"
  | "running"
  | "failed"
  | "removing"
  | "removed";

export type BringUpPlan =
  | "seed_resume"
  | "sync_close"
  | "close"
  | "full_replace";

export type DisplayPreviewStatus =
  | "provisioning"
  | "running"
  | "failed"
  | "removing"
  | "removed";

export type TeardownDeps = {
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: Pick<PreviewAppOps, "remove">;
  dataVolumes: PreviewDataVolumes;
};

export type LifecycleDeps = {
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  dataVolumes: PreviewDataVolumes;
  /**
   * Per-deploy phase stopwatch. Absent on the synchronous path, which
   * reports nothing; the async path installs a collector before bringing
   * the preview up.
   */
  phaseTimer?: PhaseTimer;
};

/** Bring-up phases with a telemetry interest, nothing more. */
export type PreviewPhase = "db" | "app" | "seed";

export const PREVIEW_PHASES: readonly PreviewPhase[] = ["db", "app", "seed"];

export type PreviewPhaseMs = { [K in PreviewPhase]?: number };

/**
 * Closed failure vocabularies for install telemetry. Writers store plain
 * strings, so the export boundary validates against these sets and maps
 * anything outside them to "unknown" instead of leaking free text.
 */
export const PREVIEW_FAILURE_CODES = [
  "preview_app_pull_failed",
  "preview_seed_pull_failed",
  "preview_service_pull_failed",
  "preview_db_create_failed",
  "preview_db_drop_failed",
  "preview_app_deploy_failed",
  "health_timeout",
  "preview_service_deploy_failed",
  "services_required_after_companion_failure",
  "seed_failed",
  "seed_image_required_to_resume_seeding",
] as const;

export type PreviewFailureCode =
  (typeof PREVIEW_FAILURE_CODES)[number];

export const PREVIEW_FAILURE_FAMILIES = [
  "seed_incomplete",
  "post_healthy",
] as const;

export type PreviewFailureFamily =
  (typeof PREVIEW_FAILURE_FAMILIES)[number];

export type PhaseTimer = {
  record(phase: PreviewPhase, ms: number): void;
};

export type { GovernanceConfig } from "@sprout/preview-env";

export type ProvisionInput = {
  repo: string;
  prId: number;
  slug: string;
  hostname: string;
  appImage: string;
  health: HealthSpec;
  seed?: SeedImageSpec;
  appEnv: string[];
  services?: PreviewServiceSpec[];
  labels?: PreviewLabels;
  plan: PreviewDbPlan;
  reseed?: boolean;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
  auth?: PreviewAuthSpec;
  previewAuth?: PreviewAuthConfig;
  governanceMs?: { ttlMs: number | null; idleMs: number | null };
};

export type TeardownInput = {
  repo: string;
  prId: number;
};

export type RemovePreviewInput = {
  repo: string;
  prId: number;
  expectedDbName: string | null;
  expectedCreatedAt: string;
  expiryReason?: string;
};

export type PreviewSnapshot = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string | null;
  hostname: string;
  status: PreviewStatus;
  preview_url?: string;
  mailbox_url?: string;
  mail_from?: string;
  mail_from_name?: string;
  last_error?: string;
  last_error_detail?: string;
  last_activity_at?: string | null;
  expires_at?: string | null;
  expiry_reason?: string | null;
};

export type TeardownSnapshot = {
  ok: true;
  status: "removed";
};
