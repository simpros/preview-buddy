import { describe, expect, test } from "bun:test";
import { DEFAULT_HEALTH, resolveHealthSpec } from "./health.ts";

describe("resolveHealthSpec", () => {
  test("defaults when omitted", () => {
    expect(resolveHealthSpec()).toEqual({
      ok: true,
      value: DEFAULT_HEALTH,
    });
  });

  test("honors yaml-shaped block", () => {
    expect(
      resolveHealthSpec({
        path: "/readyz",
        interval: "1s",
        timeout: "30s",
        expect: 204,
      }),
    ).toEqual({
      ok: true,
      value: {
        path: "/readyz",
        intervalMs: 1000,
        timeoutMs: 30_000,
        expectStatus: 204,
      },
    });
  });

  test("accepts the shared duration grammar beyond seconds", () => {
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "30m",
        timeout: "2h",
        expect: 200,
      }),
    ).toEqual({
      ok: true,
      value: {
        path: "/health",
        intervalMs: 30 * 60_000,
        timeoutMs: 2 * 3_600_000,
        expectStatus: 200,
      },
    });
  });

  test("rejects bad path, duration, and expect", () => {
    expect(
      resolveHealthSpec({
        path: "health",
        interval: "2s",
        timeout: "120s",
        expect: 200,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_path" } });
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "2x",
        timeout: "120s",
        expect: 200,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_interval" } });
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "2s",
        timeout: "0s",
        expect: 200,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_timeout" } });
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "2s",
        timeout: "120s",
        expect: 99,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_expect" } });
  });
});
