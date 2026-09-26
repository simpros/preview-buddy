import { describe, expect, test } from "bun:test";
import type { PreviewVolumeIssue } from "./index.ts";
import {
  parsePreviewVolumes,
  previewVolumeIssueMessage,
} from "./volumes.ts";

describe("parsePreviewVolumes", () => {
  test("absent and empty list mean no volumes", () => {
    expect(parsePreviewVolumes(undefined)).toEqual({
      ok: true,
      value: [],
    });
    expect(parsePreviewVolumes([])).toEqual({ ok: true, value: [] });
  });

  test("normalizes trailing slashes", () => {
    expect(parsePreviewVolumes(["/data/documents/"])).toEqual({
      ok: true,
      value: ["/data/documents"],
    });
  });

  test("rejects a non-list", () => {
    const parsed = parsePreviewVolumes("/data");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(previewVolumeIssueMessage("preview.volumes", parsed.issue)).toBe(
        "preview.volumes must be a list",
      );
    }
  });

  test("rejects relative paths and dotdot with the key named", () => {
    for (const entry of ["data/documents", "a/../b", "/data/../secrets"]) {
      const parsed = parsePreviewVolumes([entry]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(
          previewVolumeIssueMessage("preview.volumes", parsed.issue),
        ).toContain("preview.volumes[0]");
      }
    }
  });

  test("rejects duplicates after normalization", () => {
    const parsed = parsePreviewVolumes(["/data", "/data/"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const issue: PreviewVolumeIssue = parsed.issue;
      expect(issue.code).toBe("volume_duplicate");
      expect(
        previewVolumeIssueMessage("preview.volumes", issue),
      ).toContain("preview.volumes");
    }
  });

  test("rejects collision with the sqlite db.path", () => {
    const parsed = parsePreviewVolumes(["/data"], { dbPath: "/data" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issue.code).toBe("volume_collides_db_path");
      expect(
        previewVolumeIssueMessage("preview.volumes", parsed.issue),
      ).toContain("db.path");
    }
  });
});
