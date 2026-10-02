import { describe, expect, test } from "bun:test";
import {
  computeExpiresAtMs,
  connectionProjection,
  governanceStatus,
  parseGatewayCap,
  parseGatewayDurationMs,
  parsePreviewGovernanceField,
  resolveGovernanceMs,
} from "./governance.ts";

describe("preview governance durations", () => {
  test("parses manifest ttl/idle with off", () => {
    expect(parsePreviewGovernanceField("7d", "ttl")).toEqual({
      ok: true,
      value: "7d",
    });
    expect(parsePreviewGovernanceField("off", "ttl")).toEqual({
      ok: true,
      value: "off",
    });
    expect(parsePreviewGovernanceField("OFF", "idle_teardown")).toEqual({
      ok: true,
      value: "off",
    });
    expect(parsePreviewGovernanceField(undefined, "ttl")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("rejects malformed durations with named errors", () => {
    const bad = parsePreviewGovernanceField("forever", "ttl");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issue.code).toBe("invalid_ttl");
    const idleBad = parsePreviewGovernanceField("7x", "idle_teardown");
    expect(idleBad.ok).toBe(false);
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
    expect(resolveGovernanceMs("7d", 2 * 3600_000)).toBe(7 * 86400_000);
    expect(resolveGovernanceMs("off", 2 * 3600_000)).toBeNull();
    expect(resolveGovernanceMs(undefined, 2 * 3600_000)).toBe(2 * 3600_000);
    expect(resolveGovernanceMs(undefined, null)).toBeNull();
  });

  test("expiry is the earlier of ttl and idle", () => {
    const base = 1_000_000;
    expect(computeExpiresAtMs(base, 7 * 86400_000, null)).toBe(
      base + 7 * 86400_000,
    );
    expect(computeExpiresAtMs(base, 7 * 86400_000, 2 * 3600_000)).toBe(
      base + 2 * 3600_000,
    );
    expect(computeExpiresAtMs(base, null, null)).toBeNull();
  });

  test("connection projection refuses beyond the ceiling", () => {
    expect(
      connectionProjection({ activePreviews: 7, perPreview: 12, ceiling: 100 }),
    ).toEqual({ projected: 96, over: false });
    expect(
      connectionProjection({ activePreviews: 8, perPreview: 12, ceiling: 100 }),
    ).toEqual({ projected: 108, over: true });
    expect(
      connectionProjection({ activePreviews: 8, perPreview: null, ceiling: 100 }),
    ).toEqual({ projected: null, over: false });
  });

  test("governance status counts once for caps", () => {
    const previews = [
      { canonicalRepoId: "a" },
      { canonicalRepoId: "a" },
      { canonicalRepoId: "b" },
    ];
    const status = governanceStatus(previews);
    expect(status.total).toBe(3);
    expect(status.byRepo.get("a")).toBe(2);
  });
});
