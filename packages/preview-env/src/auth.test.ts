import { describe, expect, test } from "bun:test";
import {
  authSpecIssueMessage,
  parsePreviewAuthSpec,
  previewAuthMode,
} from "./auth.ts";

describe("parsePreviewAuthSpec", () => {
  test("omits to undefined (open by default)", () => {
    expect(parsePreviewAuthSpec(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(previewAuthMode(undefined)).toBe("none");
  });

  test("parses none to undefined", () => {
    expect(parsePreviewAuthSpec("none")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parsePreviewAuthSpec({ mode: "none" })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("parses basic and link in both forms", () => {
    expect(parsePreviewAuthSpec("basic")).toEqual({
      ok: true,
      value: { mode: "basic" },
    });
    expect(parsePreviewAuthSpec({ mode: "link" })).toEqual({
      ok: true,
      value: { mode: "link" },
    });
    expect(previewAuthMode({ mode: "link" })).toBe("link");
  });

  test("rejects unknown modes with a named error", () => {
    const parsed = parsePreviewAuthSpec("oidc");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(authSpecIssueMessage(parsed.issue)).toBe(
        'preview.auth must be none, basic, or link (got "oidc")',
      );
    }
  });

  test("rejects unknown keys and non-mapping blocks", () => {
    const keyed = parsePreviewAuthSpec({ mode: "basic", rbac: true });
    expect(keyed.ok).toBe(false);
    if (!keyed.ok) {
      expect(authSpecIssueMessage(keyed.issue)).toBe(
        "unknown key: preview.auth.rbac",
      );
    }
    const blocked = parsePreviewAuthSpec(42);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(authSpecIssueMessage(blocked.issue)).toBe(
        "preview.auth must be none, basic, or link",
      );
    }
  });
});
