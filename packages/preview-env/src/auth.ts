const PREVIEW_AUTH_MODES = ["none", "basic", "link"] as const;

export type PreviewAuthMode = (typeof PREVIEW_AUTH_MODES)[number];

export type PreviewAuthSpec = {
  mode: PreviewAuthMode;
};

function isAuthMode(value: string): value is PreviewAuthMode {
  return (PREVIEW_AUTH_MODES as readonly string[]).includes(value);
}

type PreviewAuthIssue =
  | { code: "invalid_auth_block" }
  | { code: "unknown_auth_key"; key: string }
  | { code: "invalid_auth_mode"; mode: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePreviewAuthSpec(
  raw: unknown,
):
  | { ok: true; value: PreviewAuthSpec | undefined }
  | { ok: false; issue: PreviewAuthIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  const obj: unknown = typeof raw === "string" ? { mode: raw } : raw;
  if (!isPlainObject(obj)) {
    return { ok: false, issue: { code: "invalid_auth_block" } };
  }
  for (const key of Object.keys(obj)) {
    if (key !== "mode") {
      return { ok: false, issue: { code: "unknown_auth_key", key } };
    }
  }
  let mode: PreviewAuthMode = "none";
  if (obj.mode !== undefined) {
    if (typeof obj.mode !== "string" || !isAuthMode(obj.mode.trim())) {
      return {
        ok: false,
        issue: { code: "invalid_auth_mode", mode: String(obj.mode) },
      };
    }
    mode = obj.mode.trim() as PreviewAuthMode;
  }
  if (mode === "none") return { ok: true, value: undefined };
  return { ok: true, value: { mode } };
}

export function authSpecIssueMessage(issue: PreviewAuthIssue): string {
  switch (issue.code) {
    case "invalid_auth_block":
      return "preview.auth must be none, basic, or link";
    case "unknown_auth_key":
      return `unknown key: preview.auth.${issue.key}`;
    case "invalid_auth_mode":
      return `preview.auth must be none, basic, or link (got ${JSON.stringify(issue.mode)})`;
  }
}

export function previewAuthMode(spec: PreviewAuthSpec | undefined): PreviewAuthMode {
  return spec?.mode ?? "none";
}
