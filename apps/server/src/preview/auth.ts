import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PreviewAuthMode } from "@sprout/preview-env";

export const PREVIEW_AUTH_COOKIE = "sprout_preview_auth";
export const PREVIEW_AUTH_PATH = "/__sprout/auth";
export const PREVIEW_AUTH_BASIC_USER = "sprout";
export const PREVIEW_AUTH_DEFAULT_EXPIRES = "7d";

export function previewAuthMiddleware(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-auth`;
}

export function generatePreviewAuthSecret(): string {
  return randomBytes(32).toString("hex");
}

export function generateBasicPassword(): string {
  return randomBytes(24)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "x");
}

/** bcrypt htpasswd entry; the hash flavour is normalised to $2y$ for Traefik. */
export async function hashBasicPassword(password: string): Promise<string> {
  const hash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });
  return hash.replace(/^\$2[aby]\$/, "$2y$");
}

type LinkPayload = {
  repo: string;
  pr: number;
  exp: number;
  v: string;
};

function base64urlEncode(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

function base64urlDecode(raw: string): string | null {
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function signPayload(secret: string, payloadB64: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("hex");
}

export function mintPreviewLinkToken(input: {
  gatewaySecret: string;
  repo: string;
  prId: number;
  version: string;
  expiresAtMs: number;
}): string {
  const payload: LinkPayload = {
    repo: input.repo,
    pr: input.prId,
    exp: input.expiresAtMs,
    v: input.version,
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = signPayload(input.gatewaySecret, `${input.version}.${payloadB64}`);
  return `${payloadB64}.${sig}`;
}

export type LinkVerifyReason =
  | "missing"
  | "malformed"
  | "invalid_signature"
  | "wrong_preview"
  | "revoked"
  | "expired";

export function verifyPreviewLinkToken(input: {
  gatewaySecret: string;
  token: string;
  repo: string;
  prId: number;
  version: string;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: LinkVerifyReason } {
  const now = input.nowMs ?? Date.now();
  const dot = input.token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payloadB64 = input.token.slice(0, dot);
  const sig = input.token.slice(dot + 1);
  const decoded = base64urlDecode(payloadB64);
  if (!decoded) return { ok: false, reason: "malformed" };
  let payload: LinkPayload;
  try {
    payload = JSON.parse(decoded) as LinkPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.repo !== "string" ||
    typeof payload.pr !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.v !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expected = signPayload(
    input.gatewaySecret,
    `${payload.v}.${payloadB64}`,
  );
  if (!safeEqualHex(sig, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (payload.repo !== input.repo || payload.pr !== input.prId) {
    return { ok: false, reason: "wrong_preview" };
  }
  if (payload.v !== input.version) {
    return { ok: false, reason: "revoked" };
  }
  if (payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function safeEqualSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const EXPIRY_RE = /^(-?\d+)(s|m|h|d)$/;

/** Parse `--expires` values (`30m`, `12h`, `7d`, ISO dates); the past is allowed so revocation tests can mint dead links. */
export function parseLinkExpiry(
  raw: string | undefined,
  nowMs?: number,
): { ok: true; expiresAtMs: number } | { ok: false; error: string } {
  const now = nowMs ?? Date.now();
  const value = (raw ?? PREVIEW_AUTH_DEFAULT_EXPIRES).trim();
  const match = EXPIRY_RE.exec(value);
  if (match) {
    const amount = Number(match[1]);
    if (!Number.isInteger(amount)) {
      return { ok: false, error: "--expires must be like 30m, 12h, 7d, or an ISO date" };
    }
    const unit = match[2] as "s" | "m" | "h" | "d";
    const factor =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return { ok: true, expiresAtMs: now + amount * factor };
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return { ok: true, expiresAtMs: parsed };
  }
  return { ok: false, error: "--expires must be like 30m, 12h, 7d, or an ISO date" };
}

export function shareableLink(hostname: string, token: string): string {
  return `https://${hostname}${PREVIEW_AUTH_PATH}?t=${token}`;
}

export type PreviewAuthState = {
  mode: PreviewAuthMode;
  /** Link version secret; rotated on revoke. Undefined when mode is not link. */
  secret: string | null;
  basicUser: string | null;
  /** Plaintext basic password; surfaced via `sprout access`, never logged. */
  basicPassword: string | null;
};

export function desiredPreviewAuthState(input: {
  mode: PreviewAuthMode;
  stored: {
    authMode: string | null;
    authSecret: string | null;
    authBasicUser: string | null;
    authBasicPassword: string | null;
  };
}): PreviewAuthState {
  const { mode, stored } = input;
  if (mode === "none") {
    return { mode, secret: null, basicUser: null, basicPassword: null };
  }
  if (mode === "basic") {
    return {
      mode,
      secret: null,
      basicUser: stored.authBasicUser ?? PREVIEW_AUTH_BASIC_USER,
      basicPassword: stored.authBasicPassword ?? generateBasicPassword(),
    };
  }
  return {
    mode,
    secret: stored.authSecret ?? generatePreviewAuthSecret(),
    basicUser: null,
    basicPassword: null,
  };
}

/** Distinguishable deny reason for the gateway log; never carries secret material. */
export function authDenyLog(input: {
  host: string;
  repo: string;
  prId: number;
  reason: string;
}): string {
  return `preview auth denied: reason=${input.reason} host=${input.host} repo=${input.repo} pr=${input.prId}`;
}
