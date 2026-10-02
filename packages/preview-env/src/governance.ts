const DURATION_RE = /^(\d+)(s|m|h|d)$/;

/**
 * Shared duration grammar for manifest fields and gateway env: "off"/empty
 * handling stays with each boundary, this only parses `<amount><unit>`.
 */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  const match = DURATION_RE.exec(trimmed);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2];
  const factor =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  const ms = amount * factor;
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return ms;
}

/** Gateway-level governance: every field resolved, null means off. */
export type GovernanceConfig = {
  /** Null means unbounded; manifest preview.ttl overrides. */
  previewTtlMs: number | null;
  /** Null means off; measured from the last successful deploy. */
  previewIdleMs: number | null;
  /** Null means unbounded. */
  maxPreviewsPerRepo: number | null;
  /** Null means unbounded. */
  maxPreviews: number | null;
  /** Expected per-preview DB connections; null means no budget. */
  previewMaxDbConnections: number | null;
  /** Instance ceiling for the budget arithmetic; null means no budget. */
  postgresMaxConnections: number | null;
};

/** Per-preview deadlines in ms; null means off. Single home for the shape
 * threaded from admission through bring-up. */
export type EffectiveGovernanceMs = {
  ttlMs: number | null;
  idleMs: number | null;
};

/** Manifest-level governance overrides; undefined means inherit the gateway.
 * Each present field is the parsed bound (null means "off"), produced once
 * at the boundary so downstream resolution is pure arithmetic with no
 * re-parse and no throw. */
export type GovernanceManifest = {
  ttlMs?: number | null;
  idleMs?: number | null;
};

export function governanceIssueMessage(path: string, raw: string): string {
  return `${path} is invalid (expected e.g. 7d, 2h, 30m or off, got ${JSON.stringify(raw)})`;
}

/**
 * Manifest-level parse: undefined means inherit the gateway default, "off"
 * disables, otherwise a duration string. The failure carries only the
 * offending input; callers already know which field they asked about, so
 * they choose the path and error code. The honest cheap activity signal is
 * the last successful deploy (including reseed/reset) — see docs/previews.md.
 */
export function parsePreviewGovernanceField(raw: unknown):
  | { ok: true; value: { raw: string; ms: number | null } | undefined }
  | { ok: false; raw: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, raw: String(raw) };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, raw };
  }
  if (trimmed.toLowerCase() === "off")
    return { ok: true, value: { raw: "off", ms: null } };
  const ms = parseDurationMs(trimmed);
  if (ms === null) {
    return { ok: false, raw };
  }
  return { ok: true, value: { raw: trimmed, ms } };
}
