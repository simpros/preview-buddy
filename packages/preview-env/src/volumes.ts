/** Per-preview app-data volumes (`preview.volumes`). */

import type { DbSpec } from "./db.ts";

export type PreviewVolumeIssue =
  | { code: "volumes_not_a_list" }
  | { code: "volumes_empty"; index: number }
  | { code: "volume_not_absolute"; index: number; path: string }
  | { code: "volume_is_root"; index: number; path: string }
  | { code: "volume_dotdot"; index: number; path: string }
  | { code: "volume_duplicate"; index: number; path: string }
  | { code: "volume_overlaps"; index: number; path: string; other: string }
  | { code: "volume_collides_db_path"; index: number; path: string };

function normalizeContainerPath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function hasDotDotSegment(path: string): boolean {
  return path.split("/").includes("..");
}

/** Equal or nested at a segment boundary: one mount would shadow the other. */
function isSameOrNested(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function parsePreviewVolumes(
  raw: unknown,
  spec?: DbSpec,
): { ok: true; value: string[] } | { ok: false; issue: PreviewVolumeIssue } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, issue: { code: "volumes_not_a_list" } };
  if (raw.length === 0) return { ok: true, value: [] };
  const out: string[] = [];
  // The db.path collision only applies to the sqlite provider.
  const dbPath =
    spec?.provider === "sqlite" ? normalizeContainerPath(spec.path) : undefined;
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        issue: {
          code: "volumes_empty",
          index,
        },
      };
    }
    const trimmed = entry.trim();
    if (!trimmed.startsWith("/")) {
      return { ok: false, issue: { code: "volume_not_absolute", index, path: entry } };
    }
    if (hasDotDotSegment(trimmed)) {
      return { ok: false, issue: { code: "volume_dotdot", index, path: entry } };
    }
    const normalized = normalizeContainerPath(trimmed);
    if (normalized === "/") {
      return { ok: false, issue: { code: "volume_is_root", index, path: entry } };
    }
    for (const prior of out) {
      if (normalized === prior) {
        return { ok: false, issue: { code: "volume_duplicate", index, path: entry } };
      }
      if (isSameOrNested(normalized, prior)) {
        return {
          ok: false,
          issue: { code: "volume_overlaps", index, path: entry, other: prior },
        };
      }
    }
    if (dbPath !== undefined && isSameOrNested(normalized, dbPath)) {
      return {
        ok: false,
        issue: { code: "volume_collides_db_path", index, path: entry },
      };
    }
    out.push(normalized);
  }
  return { ok: true, value: out };
}

export function previewVolumeIssueMessage(
  path: string,
  issue: PreviewVolumeIssue,
): string {
  switch (issue.code) {
    case "volumes_not_a_list":
      return `${path} must be a list`;
    case "volumes_empty":
      return `${path}[${issue.index}] is required`;
    case "volume_not_absolute":
      return `${path}[${issue.index}] must be an absolute container path (got ${JSON.stringify(issue.path)})`;
    case "volume_is_root":
      return `${path}[${issue.index}] must not be / (got ${JSON.stringify(issue.path)})`;
    case "volume_dotdot":
      return `${path}[${issue.index}] must not contain .. (got ${JSON.stringify(issue.path)})`;
    case "volume_duplicate":
      return `${path}: duplicate entry: ${JSON.stringify(issue.path)}`;
    case "volume_overlaps":
      return `${path}[${issue.index}] overlaps ${JSON.stringify(issue.other)}: nested mounts are not supported (got ${JSON.stringify(issue.path)})`;
    case "volume_collides_db_path":
      return `${path}[${issue.index}] collides with db.path (got ${JSON.stringify(issue.path)})`;
  }
}
