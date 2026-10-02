import {
  parseDurationMs,
  type EffectiveGovernanceMs,
  type GovernanceConfig,
  type GovernanceManifest,
} from "@sprout/preview-env";

export function hoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

/** Gateway-level parse: empty/off means unbounded, otherwise a duration. */
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

export function parseGatewayCap(
  envName: string,
  raw: string | undefined,
): number | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed.toLowerCase() === "off") return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${envName}: must be a positive integer or off`);
  }
  return value;
}

/** Manifest override wins; "off" at the effective level disables. Pure lookup:
 * the manifest already carries the parsed bound, so there is nothing to
 * re-parse and nothing to throw. */
export function resolveEffectiveGovernanceMs(
  manifest: GovernanceManifest | undefined,
  gateway: Pick<GovernanceConfig, "previewTtlMs" | "previewIdleMs">,
): EffectiveGovernanceMs {
  return {
    ttlMs:
      manifest?.ttl !== undefined ? manifest.ttl.ms : gateway.previewTtlMs,
    idleMs:
      manifest?.idle_teardown !== undefined
        ? manifest.idle_teardown.ms
        : gateway.previewIdleMs,
  };
}

/**
 * One place decides the expiry base, the earlier bound, and which bound won.
 * The base falls back to creation when no successful deploy has refreshed
 * activity yet, so the read surface and the sweep plan from the same source.
 * The legacy creation-age bound applies only when both governance bounds are
 * null (rows that never received governance columns): once a preview carries
 * an explicit ttl/idle, that policy wins over the legacy default.
 */
export function resolvePreviewExpiry(input: {
  lastActivityMs: number | null;
  createdAtMs: number | null;
  ttlMs: number | null;
  idleMs: number | null;
  legacyTtlMs: number | null;
}): { expiresAtMs: number | null; bound: "ttl" | "idle" | null } {
  const base = input.lastActivityMs ?? input.createdAtMs;
  if (base === null) return { expiresAtMs: null, bound: null };
  const ttlDeadline = input.ttlMs !== null ? base + input.ttlMs : null;
  const idleDeadline = input.idleMs !== null ? base + input.idleMs : null;
  if (ttlDeadline !== null || idleDeadline !== null) {
    if (
      ttlDeadline !== null &&
      (idleDeadline === null || ttlDeadline <= idleDeadline)
    ) {
      return { expiresAtMs: ttlDeadline, bound: "ttl" };
    }
    return { expiresAtMs: idleDeadline, bound: "idle" };
  }
  if (input.legacyTtlMs !== null && input.createdAtMs !== null) {
    return {
      expiresAtMs: input.createdAtMs + input.legacyTtlMs,
      bound: "ttl",
    };
  }
  return { expiresAtMs: null, bound: null };
}

export type GovernanceStatus = {
  total: number;
  byRepo: Map<string, number>;
};

/**
 * One pass over live previews for the cap checks. Connection budget is not
 * part of the status: the evaluator projects it with an explicit count, so
 * there is no hidden +1 convention.
 */
export function governanceStatus(
  previews: readonly { canonicalRepoId: string }[],
): GovernanceStatus {
  const byRepo = new Map<string, number>();
  for (const preview of previews) {
    byRepo.set(
      preview.canonicalRepoId,
      (byRepo.get(preview.canonicalRepoId) ?? 0) + 1,
    );
  }
  return { total: previews.length, byRepo };
}

/**
 * Projected connections for exactly `previews` live previews, or null when
 * no budget is configured. The evaluator passes the candidate explicitly:
 * admission includes the newcomer, the sweep passes the current total as-is.
 */
export function connectionProjection(input: {
  previews: number;
  perPreview: number | null;
  ceiling: number | null;
}): { projected: number; over: boolean } | null {
  if (input.perPreview === null || input.ceiling === null) return null;
  const projected = input.previews * input.perPreview;
  return { projected, over: projected > input.ceiling };
}

export type GovernanceViolation =
  | { kind: "per-repo-cap"; repo: string; cap: number; count: number }
  | { kind: "total-cap"; cap: number; count: number }
  | {
      kind: "connection-budget";
      projected: number;
      ceiling: number;
      perPreview: number;
      previews: number;
    };

/**
 * Single owner of violation presentation, shared by admission (which maps
 * violations to 429s) and the sweep (which prefixes them as over-limit
 * logs). One switch, no second copy of the wording in either caller.
 */
export function violationMessage(violation: GovernanceViolation): string {
  switch (violation.kind) {
    case "per-repo-cap":
      return (
        `SPROUT_MAX_PREVIEWS_PER_REPO limit reached (limit ${violation.cap}, ` +
        `current ${violation.count})`
      );
    case "total-cap":
      return (
        `SPROUT_MAX_PREVIEWS limit reached (limit ${violation.cap}, ` +
        `current ${violation.count})`
      );
    case "connection-budget":
      return (
        `preview connection budget exceeded (projected ${violation.projected} > ` +
        `ceiling ${violation.ceiling}; ${violation.previews} previews x ` +
        `${violation.perPreview} per preview)`
      );
  }
}

/**
 * Single evaluator for the cap/budget policy, shared by admission (which maps
 * violations to 429s) and the sweep (which logs them). `pending` is the
 * not-yet-inserted candidate: admission passes it so the newcomer counts
 * against the caps (`count + 1 > cap`, i.e. reject at the cap), while the
 * sweep passes null to report only rows already over (`count > cap`).
 * Presentation lives in `violationMessage`: one switch, no second copy of
 * the wording in either caller.
 */
export function evaluateGovernance(
  gov: GovernanceConfig,
  status: GovernanceStatus,
  pending: { repo: string } | null,
): GovernanceViolation[] {
  const violations: GovernanceViolation[] = [];
  const incoming = pending === null ? 0 : 1;

  const perRepo = gov.maxPreviewsPerRepo;
  if (perRepo !== null) {
    if (pending !== null) {
      const count = status.byRepo.get(pending.repo) ?? 0;
      if (count + incoming > perRepo) {
        violations.push({
          kind: "per-repo-cap",
          repo: pending.repo,
          cap: perRepo,
          count,
        });
      }
    } else {
      for (const [repo, count] of status.byRepo) {
        if (count > perRepo) {
          violations.push({ kind: "per-repo-cap", repo, cap: perRepo, count });
        }
      }
    }
  }

  const total = gov.maxPreviews;
  if (total !== null && status.total + incoming > total) {
    violations.push({ kind: "total-cap", cap: total, count: status.total });
  }

  const perPreview = gov.previewMaxDbConnections;
  const ceiling = gov.postgresMaxConnections;
  if (perPreview !== null && ceiling !== null) {
    const budget = connectionProjection({
      previews: status.total + incoming,
      perPreview,
      ceiling,
    });
    if (budget !== null && budget.over) {
      violations.push({
        kind: "connection-budget",
        projected: budget.projected,
        ceiling,
        perPreview,
        previews: status.total + incoming,
      });
    }
  }

  return violations;
}
