import { describe, expect, test } from "bun:test";
import type { GovernanceConfig } from "@sprout/preview-env";
import {
  connectionProjection,
  evaluateGovernance,
  governanceStatus,
  hoursToMs,
  parseGatewayCap,
  parseGatewayDurationMs,
  resolveEffectiveGovernanceMs,
  resolvePreviewExpiry,
  violationMessage,
} from "./governance.ts";
import { governanceConfig } from "./governance-fixtures.ts";

const REPO_A = "https://github.com/acme/a";
const REPO_B = "https://github.com/acme/b";

const off: GovernanceConfig = governanceConfig();

describe("server governance policy", () => {
  test("status counts once for caps", () => {
    const status = governanceStatus([
      { canonicalRepoId: REPO_A },
      { canonicalRepoId: REPO_A },
      { canonicalRepoId: REPO_B },
    ]);
    expect(status.total).toBe(3);
    expect(status.byRepo.get(REPO_A)).toBe(2);
  });

  test("projection is null without a budget, arithmetic with one", () => {
    expect(
      connectionProjection({ previews: 9, perPreview: null, ceiling: 100 }),
    ).toBeNull();
    expect(
      connectionProjection({ previews: 8, perPreview: 12, ceiling: 100 }),
    ).toEqual({ projected: 96, over: false });
    expect(
      connectionProjection({ previews: 9, perPreview: 12, ceiling: 100 }),
    ).toEqual({ projected: 108, over: true });
  });

  test("pending candidate counts against caps; settled rows only log over", () => {
    const gov: GovernanceConfig = { ...off, maxPreviews: 1 };
    const status = governanceStatus([{ canonicalRepoId: REPO_A }]);
    expect(evaluateGovernance(gov, status, { repo: REPO_B })).toEqual([
      {
        kind: "total-cap",
        code: "preview_limit_reached",
        cap: 1,
        count: 1,
      },
    ]);
    expect(evaluateGovernance(gov, status, null)).toEqual([]);
  });

  test("per-repo violation precedes total, total precedes budget", () => {
    const gov: GovernanceConfig = {
      ...off,
      maxPreviewsPerRepo: 1,
      maxPreviews: 1,
      previewMaxDbConnections: 12,
      postgresMaxConnections: 20,
    };
    const status = governanceStatus([{ canonicalRepoId: REPO_A }]);
    const violations = evaluateGovernance(gov, status, { repo: REPO_A });
    expect(violations.map((v) => v.kind)).toEqual([
      "per-repo-cap",
      "total-cap",
      "connection-budget",
    ]);
  });

  test("budget violation counts the previews the projection counts", () => {
    const gov: GovernanceConfig = {
      ...off,
      previewMaxDbConnections: 12,
      postgresMaxConnections: 20,
    };
    const status = governanceStatus([{ canonicalRepoId: REPO_A }]);
    expect(evaluateGovernance(gov, status, { repo: REPO_B })).toEqual([
      {
        kind: "connection-budget",
        code: "preview_connection_budget_exceeded",
        projected: 24,
        ceiling: 20,
        perPreview: 12,
        previews: 2,
      },
    ]);
  });

  test("one message per violation kind", () => {
    expect(
      violationMessage({
        kind: "per-repo-cap",
        code: "preview_limit_reached",
        repo: REPO_A,
        cap: 1,
        count: 1,
      }),
    ).toBe("SPROUT_MAX_PREVIEWS_PER_REPO limit reached (limit 1, current 1)");
    expect(
      violationMessage({
        kind: "total-cap",
        code: "preview_limit_reached",
        cap: 1,
        count: 1,
      }),
    ).toBe("SPROUT_MAX_PREVIEWS limit reached (limit 1, current 1)");
    expect(
      violationMessage({
        kind: "connection-budget",
        code: "preview_connection_budget_exceeded",
        projected: 24,
        ceiling: 20,
        perPreview: 12,
        previews: 2,
      }),
    ).toBe(
      "preview connection budget exceeded " +
        "(projected 24 > ceiling 20; 2 previews x 12 per preview)",
    );
  });

  test("gateway duration accepts off and rejects garbage", () => {
    expect(parseGatewayDurationMs("SPROUT_PREVIEW_TTL", undefined)).toBeNull();
    expect(parseGatewayDurationMs("SPROUT_PREVIEW_TTL", "off")).toBeNull();
    expect(parseGatewayDurationMs("SPROUT_PREVIEW_TTL", "7d")).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(parseGatewayDurationMs("SPROUT_PREVIEW_TTL", "2h")).toBe(
      2 * 60 * 60 * 1000,
    );
    expect(() =>
      parseGatewayDurationMs("SPROUT_PREVIEW_TTL", "forever"),
    ).toThrow("Invalid SPROUT_PREVIEW_TTL");
  });

  test("gateway caps accept off and reject garbage", () => {
    expect(parseGatewayCap("SPROUT_MAX_PREVIEWS", undefined)).toBeNull();
    expect(parseGatewayCap("SPROUT_MAX_PREVIEWS", "off")).toBeNull();
    expect(parseGatewayCap("SPROUT_MAX_PREVIEWS", "10")).toBe(10);
    expect(() => parseGatewayCap("SPROUT_MAX_PREVIEWS", "0")).toThrow(
      "Invalid SPROUT_MAX_PREVIEWS",
    );
  });

  test("manifest overrides gateway and off disables", () => {
    const gateway = { previewTtlMs: 2 * 3600_000, previewIdleMs: null };
    expect(
      resolveEffectiveGovernanceMs(
        { ttl: { raw: "7d", ms: 7 * 86400_000 } },
        gateway,
      ),
    ).toEqual({ ttlMs: 7 * 86400_000, idleMs: null });
    expect(
      resolveEffectiveGovernanceMs({ ttl: { raw: "off", ms: null } }, gateway),
    ).toEqual({ ttlMs: null, idleMs: null });
    expect(resolveEffectiveGovernanceMs(undefined, gateway)).toEqual({
      ttlMs: 2 * 3600_000,
      idleMs: null,
    });
    expect(
      resolveEffectiveGovernanceMs(undefined, {
        previewTtlMs: null,
        previewIdleMs: null,
      }),
    ).toEqual({ ttlMs: null, idleMs: null });
  });

  test("expiry resolves the earlier bound and names the winner", () => {
    const base = 1_000_000;
    expect(
      resolvePreviewExpiry({
        lastActivityMs: base,
        createdAtMs: base,
        ttlMs: 7 * 86400_000,
        idleMs: null,
        legacyTtlMs: 72 * 3600_000,
      }),
    ).toEqual({ expiresAtMs: base + 7 * 86400_000, bound: "ttl" });
    expect(
      resolvePreviewExpiry({
        lastActivityMs: base,
        createdAtMs: base,
        ttlMs: 7 * 86400_000,
        idleMs: 2 * 3600_000,
        legacyTtlMs: 72 * 3600_000,
      }),
    ).toEqual({ expiresAtMs: base + 2 * 3600_000, bound: "idle" });
    expect(
      resolvePreviewExpiry({
        lastActivityMs: null,
        createdAtMs: base,
        ttlMs: 7 * 86400_000,
        idleMs: null,
        legacyTtlMs: 72 * 3600_000,
      }),
    ).toEqual({ expiresAtMs: base + 7 * 86400_000, bound: "ttl" });
    expect(
      resolvePreviewExpiry({
        lastActivityMs: null,
        createdAtMs: null,
        ttlMs: 7 * 86400_000,
        idleMs: null,
        legacyTtlMs: 72 * 3600_000,
      }),
    ).toEqual({ expiresAtMs: null, bound: null });
    expect(
      resolvePreviewExpiry({
        lastActivityMs: base,
        createdAtMs: base,
        ttlMs: null,
        idleMs: null,
        legacyTtlMs: 72 * 3600_000,
      }),
    ).toEqual({ expiresAtMs: null, bound: null });
  });

  test("legacy creation-age bound only collects rows without governance", () => {
    const base = 1_000_000;
    const legacyTtlMs = 72 * 3600_000;
    expect(
      resolvePreviewExpiry({
        lastActivityMs: null,
        createdAtMs: base,
        ttlMs: null,
        idleMs: null,
        legacyTtlMs,
      }),
    ).toEqual({ expiresAtMs: base + legacyTtlMs, bound: "ttl" });
    // Explicit governance wins over the legacy default, even when older.
    expect(
      resolvePreviewExpiry({
        lastActivityMs: null,
        createdAtMs: base,
        ttlMs: 7 * 86400_000,
        idleMs: null,
        legacyTtlMs,
      }),
    ).toEqual({ expiresAtMs: base + 7 * 86400_000, bound: "ttl" });
    // A governed deploy with both bounds off stays unbounded: activity was
    // recorded together with the null bounds, so the legacy default no
    // longer applies.
    expect(
      resolvePreviewExpiry({
        lastActivityMs: base,
        createdAtMs: base,
        ttlMs: null,
        idleMs: null,
        legacyTtlMs,
      }),
    ).toEqual({ expiresAtMs: null, bound: null });
    // Unparseable creation still yields no deadline.
    expect(
      resolvePreviewExpiry({
        lastActivityMs: null,
        createdAtMs: null,
        ttlMs: null,
        idleMs: null,
        legacyTtlMs,
      }),
    ).toEqual({ expiresAtMs: null, bound: null });
  });

  test("hours convert once for the legacy bound", () => {
    expect(hoursToMs(72)).toBe(72 * 3600_000);
  });
});
