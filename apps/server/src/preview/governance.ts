import {
  type ConnectionBudget,
  type EffectiveGovernanceMs,
  type GovernanceConfig,
  type GovernanceManifest,
} from "@sprout/preview-env";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";

/** Manifest override wins; "off" at the effective level disables. Pure lookup:
 * the manifest already carries the parsed bound, so there is nothing to
 * re-parse and nothing to throw. */
export function resolveEffectiveGovernanceMs(
  manifest: GovernanceManifest | undefined,
  gateway: Pick<GovernanceConfig, "previewTtlMs" | "previewIdleMs">,
): EffectiveGovernanceMs {
  return {
    ttlMs:
      manifest?.ttlMs !== undefined ? manifest.ttlMs : gateway.previewTtlMs,
    idleMs:
      manifest?.idleMs !== undefined ? manifest.idleMs : gateway.previewIdleMs,
  };
}

/**
 * One place decides the expiry base, the earlier bound, and which bound won.
 * The base falls back to creation when no successful deploy has refreshed
 * activity yet, so the read surface and the sweep plan from the same source.
 * The legacy creation-age bound applies only to rows that never completed
 * a governed deploy (lastActivityMs null): closeRunning writes activity
 * together with the effective ttl/idle, so null bounds past that point
 * mean explicit "off" and yield no deadline.
 */
export function resolvePreviewExpiry(input: {
  lastActivityMs: number | null;
  createdAtMs: number | null;
  ttlMs: number | null;
  idleMs: number | null;
  legacyTtlMs: number;
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
  if (input.lastActivityMs === null && input.createdAtMs !== null) {
    return {
      expiresAtMs: input.createdAtMs + input.legacyTtlMs,
      bound: "ttl",
    };
  }
  return { expiresAtMs: null, bound: null };
}

/**
 * Row-shaped entry to the shared expiry derivation: parses the stored
 * instants once, so the read surface and the sweep plan from one mapping
 * instead of each parsing the same columns. Unparseable instants yield no
 * deadline rather than a guessed one.
 */
export function resolveRowExpiry(
  row: {
    lastActivityAt: string | null;
    createdAt: string;
    ttlMs: number | null;
    idleMs: number | null;
  },
  legacyTtlMs: number,
): { expiresAtMs: number | null; bound: "ttl" | "idle" | null } {
  return resolvePreviewExpiry({
    lastActivityMs: parseUnambiguousUtcMs(row.lastActivityAt ?? ""),
    createdAtMs: parseUnambiguousUtcMs(row.createdAt),
    ttlMs: row.ttlMs ?? null,
    idleMs: row.idleMs ?? null,
    legacyTtlMs,
  });
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
 * no budget is configured. The budget arrives as one pair object, so a
 * half-configured budget is unrepresentable past the config boundary and
 * the evaluator passes the candidate count explicitly: admission includes
 * the newcomer, the sweep passes the current total as-is.
 */
export function connectionProjection(input: {
  previews: number;
  budget: ConnectionBudget | null;
}): { projected: number; over: boolean } | null {
  if (input.budget === null) return null;
  const projected = input.previews * input.budget.perPreview;
  return { projected, over: projected > input.budget.ceiling };
}

export type GovernanceViolation =
  | {
      kind: "per-repo-cap";
      code: "preview_limit_reached";
      repo: string;
      cap: number;
      count: number;
    }
  | {
      kind: "total-cap";
      code: "preview_limit_reached";
      cap: number;
      count: number;
    }
  | {
      kind: "connection-budget";
      code: "preview_connection_budget_exceeded";
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
 * Presentation lives in `violationMessage` and the 429 wire code on the
 * violation itself, so callers emit without re-switching on `kind`.
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
    const candidates: [string, number][] =
      pending !== null
        ? [[pending.repo, status.byRepo.get(pending.repo) ?? 0]]
        : [...status.byRepo];
    for (const [repo, count] of candidates) {
      if (count + incoming > perRepo) {
        violations.push({
          kind: "per-repo-cap",
          code: "preview_limit_reached",
          repo,
          cap: perRepo,
          count,
        });
      }
    }
  }

  const total = gov.maxPreviews;
  if (total !== null && status.total + incoming > total) {
    violations.push({
      kind: "total-cap",
      code: "preview_limit_reached",
      cap: total,
      count: status.total,
    });
  }

  const budget = gov.connectionBudget;
  const projection = connectionProjection({
    previews: status.total + incoming,
    budget,
  });
  if (budget !== null && projection?.over) {
    violations.push({
      kind: "connection-budget",
      code: "preview_connection_budget_exceeded",
      projected: projection.projected,
      ceiling: budget.ceiling,
      perPreview: budget.perPreview,
      previews: status.total + incoming,
    });
  }

  return violations;
}
