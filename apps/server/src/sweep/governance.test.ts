import { describe, expect, setSystemTime, test, afterEach } from "bun:test";
import {
  planGovernanceExpiry,
  runSweepPass,
  type SweepPreview,
} from "./reconcile.ts";

function preview(over: Partial<SweepPreview> = {}): SweepPreview {
  return {
    canonicalRepoId: "https://github.com/acme/widgets",
    prId: 5,
    slug: "widgets",
    dbName: "sprout_widgets_pr5",
    createdAt: "2026-09-02T12:00:00.000Z",
    createdAtMs: Date.parse("2026-09-02T12:00:00.000Z"),
    status: "running",
    ...over,
  };
}

describe("governance expiry", () => {
  afterEach(() => setSystemTime());

  test("expires by stored expires_at with ttl reason", () => {
    setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    const base = Date.parse("2026-09-02T12:00:00.000Z");
    const p = preview({
      lastActivityMs: base,
      ttlMs: 7 * 86400_000,
      idleMs: null,
      expiresAtMs: base + 7 * 86400_000,
    });
    // now is past 7d
    setSystemTime(new Date(base + 8 * 86400_000));
    expect(planGovernanceExpiry(p, Date.now())).toBe("sweep:ttl-expired");
  });

  test("expires by idle with idle reason", () => {
    const base = Date.parse("2026-09-02T12:00:00.000Z");
    const p = preview({
      lastActivityMs: base,
      ttlMs: null,
      idleMs: 2 * 3600_000,
      expiresAtMs: base + 2 * 3600_000,
    });
    expect(
      planGovernanceExpiry(p, base + 3 * 3600_000),
    ).toBe("sweep:idle-expired");
    expect(planGovernanceExpiry(p, base + 3600_000)).toBeNull();
  });

  test("off at either level disables (null means keep)", () => {
    const base = Date.parse("2026-09-02T12:00:00.000Z");
    const p = preview({
      lastActivityMs: base,
      ttlMs: null,
      idleMs: null,
      expiresAtMs: null,
    });
    expect(planGovernanceExpiry(p, base + 30 * 86400_000)).toBeNull();
  });

  test("stale stored deadline does not outlive a refresh", () => {
    const base = Date.parse("2026-09-02T12:00:00.000Z");
    const refreshed = base + 8 * 86400_000;
    const stale = preview({
      lastActivityMs: refreshed,
      ttlMs: 7 * 86400_000,
      idleMs: null,
      expiresAtMs: base + 7 * 86400_000,
    });
    expect(planGovernanceExpiry(stale, base + 8 * 86400_000)).toBeNull();
    expect(
      planGovernanceExpiry(stale, refreshed + 7 * 86400_000),
    ).toBe("sweep:ttl-expired");
  });

  test("sweep removes expired preview without forge call", async () => {
    const base = Date.parse("2026-09-02T12:00:00.000Z");
    setSystemTime(new Date(base + 8 * 86400_000));
    const deletions: unknown[] = [];
    const forgeCalls: string[] = [];
    const result = await runSweepPass({
      listPreviews: async () => [
        preview({
          lastActivityMs: base,
          ttlMs: 7 * 86400_000,
          idleMs: null,
          expiresAtMs: base + 7 * 86400_000,
        }),
      ],
      listCatalogDatabases: async () => [],
      listDataVolumes: async () => [],
      listPreviewContainers: async () => [],
      listOpenPrIds: async (repo) => {
        forgeCalls.push(repo);
        return [5];
      },
      drop: async (d) => {
        deletions.push(d);
        return true;
      },
      ttlHours: 72 * 365,
    });
    expect(deletions).toEqual([
      expect.objectContaining({ reason: "sweep:ttl-expired", prId: 5 }),
    ]);
    expect(forgeCalls).toEqual([]);
    expect(result.deletions).toHaveLength(1);
  });

  test("sweep logs over-cap state", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const logs: string[] = [];
    await runSweepPass({
      listPreviews: async () => [preview(), preview({ prId: 6 })],
      listCatalogDatabases: async () => [],
      listDataVolumes: async () => [],
      listPreviewContainers: async () => [],
      listOpenPrIds: async () => [5, 6],
      drop: async () => true,
      ttlHours: 72 * 365,
      governance: {
        previewTtlMs: null,
        previewIdleMs: null,
        maxPreviews: 1,
        maxPreviewsPerRepo: 1,
        previewMaxDbConnections: null,
        postgresMaxConnections: null,
      },
      log: (m) => {
        logs.push(m);
      },
    });
    expect(logs.some((m) => m.includes("SPROUT_MAX_PREVIEWS"))).toBe(true);
  });
});
