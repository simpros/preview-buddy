import { describe, expect, test } from "bun:test";
import {
  governanceIssueMessage,
  parseDurationMs,
  parsePreviewGovernanceField,
} from "./governance.ts";

describe("preview governance durations", () => {
  test("parses manifest ttl/idle with off", () => {
    expect(parsePreviewGovernanceField("7d")).toEqual({
      ok: true,
      value: { raw: "7d", ms: 7 * 86400_000 },
    });
    expect(parsePreviewGovernanceField("off")).toEqual({
      ok: true,
      value: { raw: "off", ms: null },
    });
    expect(parsePreviewGovernanceField("OFF")).toEqual({
      ok: true,
      value: { raw: "off", ms: null },
    });
    expect(parsePreviewGovernanceField(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("rejects malformed durations, keeping the raw input", () => {
    expect(parsePreviewGovernanceField("forever")).toEqual({
      ok: false,
      raw: "forever",
    });
    expect(parsePreviewGovernanceField("7x")).toEqual({
      ok: false,
      raw: "7x",
    });
    expect(parsePreviewGovernanceField("")).toEqual({
      ok: false,
      raw: "",
    });
    expect(parsePreviewGovernanceField(42)).toEqual({
      ok: false,
      raw: "42",
    });
  });

  test("issue message names the path and the raw input", () => {
    expect(governanceIssueMessage("preview.ttl", "forever")).toBe(
      'preview.ttl is invalid (expected e.g. 7d, 2h, 30m or off, got "forever")',
    );
  });

  test("duration grammar rejects non-positive and overflowing amounts", () => {
    expect(parseDurationMs("7d")).toBe(7 * 86400_000);
    expect(parseDurationMs("2h")).toBe(2 * 3600_000);
    expect(parseDurationMs("0d")).toBeNull();
    expect(parseDurationMs("-1d")).toBeNull();
    expect(parseDurationMs("7x")).toBeNull();
    expect(parseDurationMs("999999999999d")).toBeNull();
  });
});
