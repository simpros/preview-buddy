import { deriveMailFromName } from "@sprout/preview-env";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
import { resolvePreviewExpiry } from "./governance.ts";
import type { Result } from "./result.ts";
import type { PreviewRow } from "./row.ts";
import type {
  DisplayPreviewStatus,
  PreviewSnapshot,
  PreviewStatus,
} from "./types.ts";

/**
 * Single home for the mailbox invariant: a preview with no From identity
 * (mail:none) never advertises the config-level mailbox link. Snapshots
 * carry only stored mail_from; the HTTP edge adds the link.
 */
export function parsePreviewStatus(status: string): Result<PreviewStatus> {
  switch (status) {
    case "provisioning":
    case "starting":
    case "seeding":
    case "running":
    case "failed":
    case "removing":
    case "removed":
      return { ok: true, value: status };
    default:
      return { ok: false, status: 500, error: "unknown_preview_status" };
  }
}

/**
 * Read-surface expiry: derived from the same inputs the sweep plans from —
 * the canonical UTC-instant parse, the governance bounds, and the legacy
 * creation-age bound — so the displayed deadline and the deletion decision
 * come from one derivation. Tombstones report null, matching the
 * pre-derivation display.
 */
export function expiresAtForRow(
  row: Pick<
    PreviewRow,
    "status" | "lastActivityAt" | "createdAt" | "ttlMs" | "idleMs"
  >,
  legacyTtlMs: number,
): string | null {
  if (row.status === "removed") return null;
  const { expiresAtMs } = resolvePreviewExpiry({
    lastActivityMs: parseUnambiguousUtcMs(row.lastActivityAt ?? ""),
    createdAtMs: parseUnambiguousUtcMs(row.createdAt),
    ttlMs: row.ttlMs ?? null,
    idleMs: row.idleMs ?? null,
    legacyTtlMs,
  });
  return expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();
}

export function previewSnapshotFromRow(
  row: PreviewRow,
  legacyTtlMs: number,
): PreviewSnapshot {
  const status = parsePreviewStatus(row.status);
  const parsed = status.ok ? status.value : "failed";
  const effectiveFrom = row.mailFrom ?? undefined;
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: parsed,
    ...(parsed === "running" ? { preview_url: `https://${row.hostname}` } : {}),
    // Mail-free by construction: stored mail_from only, never the
    // config-level mailbox link. The HTTP edge applies presentPreviewSnapshot.
    ...(effectiveFrom !== undefined
      ? {
          mail_from: effectiveFrom,
          mail_from_name: deriveMailFromName(row.slug, row.prId),
        }
      : {}),
    ...(row.lastError != null ? { last_error: row.lastError } : {}),
    ...(row.lastErrorDetail != null
      ? { last_error_detail: row.lastErrorDetail }
      : {}),
    last_activity_at: row.lastActivityAt ?? null,
    expires_at: expiresAtForRow(row, legacyTtlMs),
    expiry_reason: row.expiryReason ?? null,
  };
}

/**
 * Sole presenter for HTTP edges: the stored mail_from plus the config-level
 * mailbox link (never advertised for a mail:none preview). Domain layers
 * return mail-free snapshots or rows; only routes call this.
 */
export function presentPreviewSnapshot(
  row: PreviewRow,
  mailboxUrl: string | undefined,
  legacyTtlMs: number,
): PreviewSnapshot {
  const snapshot = previewSnapshotFromRow(row, legacyTtlMs);
  if (snapshot.mail_from === undefined || mailboxUrl === undefined) {
    return snapshot;
  }
  return { ...snapshot, mailbox_url: mailboxUrl };
}

export type ListedPreview = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string | null;
  hostname: string;
  status: DisplayPreviewStatus;
  created_at: string;
  mailbox_url?: string;
  mail_from?: string;
  mail_from_name?: string;
  last_activity_at: string | null;
  expires_at: string | null;
  expiry_reason: string | null;
};

/**
 * Sole list presenter: the decorated snapshot plus the list-only wire shape
 * (display status, created_at). Read edges map rows through this with no
 * spreads so preview_url/last_error never leak into the list.
 */
export function presentListedPreview(
  row: PreviewRow,
  mailboxUrl: string | undefined,
  status: DisplayPreviewStatus,
  legacyTtlMs: number,
): ListedPreview {
  const snap = presentPreviewSnapshot(row, mailboxUrl, legacyTtlMs);
  return {
    canonical_repo_id: snap.canonical_repo_id,
    pr_id: snap.pr_id,
    slug: snap.slug,
    db_name: snap.db_name,
    hostname: snap.hostname,
    status,
    created_at: row.createdAt,
    last_activity_at: snap.last_activity_at,
    expires_at: snap.expires_at,
    expiry_reason: snap.expiry_reason,
    ...(snap.mail_from !== undefined ? { mail_from: snap.mail_from } : {}),
    ...(snap.mail_from_name !== undefined
      ? { mail_from_name: snap.mail_from_name }
      : {}),
    ...(snap.mailbox_url !== undefined
      ? { mailbox_url: snap.mailbox_url }
      : {}),
  };
}
