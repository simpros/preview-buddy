const DURATION_RE = /^(\d+)(s|m|h|d)$/;

function parseDurationMs(raw: string): number | null {
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

type GovernanceFieldIssue = {
  code: "invalid_ttl" | "invalid_idle_teardown";
  raw: string;
};

export function governanceIssueMessage(
  path: string,
  issue: GovernanceFieldIssue,
): string {
  return `${path} is invalid (expected e.g. 7d, 2h, 30m or off, got ${JSON.stringify(issue.raw)})`;
}

/**
 * Manifest-level parse: undefined means inherit the gateway default, "off"
 * disables, otherwise a duration string. The honest cheap activity signal is
 * the last successful deploy (including reseed/reset) — see docs/previews.md.
 */
export function parsePreviewGovernanceField(
  raw: unknown,
  kind: "ttl" | "idle_teardown",
):
  | { ok: true; value: string | undefined }
  | { ok: false; issue: GovernanceFieldIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return {
      ok: false,
      issue: {
        code: kind === "ttl" ? "invalid_ttl" : "invalid_idle_teardown",
        raw: String(raw),
      },
    };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      issue: {
        code: kind === "ttl" ? "invalid_ttl" : "invalid_idle_teardown",
        raw,
      },
    };
  }
  if (trimmed.toLowerCase() === "off") return { ok: true, value: "off" };
  if (parseDurationMs(trimmed) === null) {
    return {
      ok: false,
      issue: {
        code: kind === "ttl" ? "invalid_ttl" : "invalid_idle_teardown",
        raw,
      },
    };
  }
  return { ok: true, value: trimmed };
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

/** Manifest override wins; "off" at the effective level disables. */
export function resolveGovernanceMs(
  manifestRaw: string | undefined,
  gatewayMs: number | null,
): number | null {
  if (manifestRaw !== undefined) {
    if (manifestRaw.trim().toLowerCase() === "off") return null;
    const ms = parseDurationMs(manifestRaw);
    if (ms === null) throw new Error(`invalid governance duration ${manifestRaw}`);
    return ms;
  }
  return gatewayMs;
}

export function computeExpiresAtMs(
  lastActivityMs: number,
  ttlMs: number | null,
  idleMs: number | null,
): number | null {
  const deadlines: number[] = [];
  if (ttlMs !== null) deadlines.push(lastActivityMs + ttlMs);
  if (idleMs !== null) deadlines.push(lastActivityMs + idleMs);
  if (deadlines.length === 0) return null;
  return Math.min(...deadlines);
}

export function connectionProjection(input: {
  activePreviews: number;
  perPreview: number | null;
  ceiling: number | null;
}): { projected: number | null; over: boolean } {
  if (input.perPreview === null || input.ceiling === null) {
    return { projected: null, over: false };
  }
  const projected = (input.activePreviews + 1) * input.perPreview;
  return { projected, over: projected > input.ceiling };
}

export function previewLimitDetail(input: {
  cap: string;
  value: number;
  count: number;
}): string {
  return `${input.cap} limit reached (limit ${input.value}, current ${input.count})`;
}

export function connectionBudgetDetail(input: {
  projected: number;
  ceiling: number;
  perPreview: number;
  active: number;
}): string {
  return (
    `preview connection budget exceeded (projected ${input.projected} > ceiling ${input.ceiling}; ` +
    `${input.active} active previews + 1 x ${input.perPreview} per preview)`
  );
}
