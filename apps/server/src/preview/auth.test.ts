import { describe, expect, test } from "bun:test";
import {
  authDenyLog,
  desiredPreviewAuthState,
  generateBasicPassword,
  generatePreviewAuthSecret,
  hashBasicPassword,
  mintPreviewLinkToken,
  parseLinkExpiry,
  previewAuthMiddleware,
  shareableLink,
  verifyPreviewLinkToken,
} from "./auth.ts";

const SECRET = "gateway-secret-for-tests";
const REPO = "https://github.com/org/repo";

describe("preview link tokens", () => {
  test("mint verifies on the same preview", () => {
    const token = mintPreviewLinkToken({
      gatewaySecret: SECRET,
      repo: REPO,
      prId: 42,
      version: "v1",
      expiresAtMs: Date.now() + 60_000,
    });
    expect(
      verifyPreviewLinkToken({
        gatewaySecret: SECRET,
        token,
        repo: REPO,
        prId: 42,
        version: "v1",
      }),
    ).toEqual({ ok: true });
  });

  test("same token is rejected on another preview's host", () => {
    const token = mintPreviewLinkToken({
      gatewaySecret: SECRET,
      repo: REPO,
      prId: 42,
      version: "v1",
      expiresAtMs: Date.now() + 60_000,
    });
    expect(
      verifyPreviewLinkToken({
        gatewaySecret: SECRET,
        token,
        repo: REPO,
        prId: 43,
        version: "v1",
      }),
    ).toEqual({ ok: false, reason: "wrong_preview" });
  });

  test("rotation invalidates outstanding links", () => {
    const token = mintPreviewLinkToken({
      gatewaySecret: SECRET,
      repo: REPO,
      prId: 42,
      version: "v1",
      expiresAtMs: Date.now() + 60_000,
    });
    expect(
      verifyPreviewLinkToken({
        gatewaySecret: SECRET,
        token,
        repo: REPO,
        prId: 42,
        version: "v2",
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  test("expired and tampered tokens fail with distinct reasons", () => {
    const dead = mintPreviewLinkToken({
      gatewaySecret: SECRET,
      repo: REPO,
      prId: 42,
      version: "v1",
      expiresAtMs: Date.now() - 1000,
    });
    expect(
      verifyPreviewLinkToken({
        gatewaySecret: SECRET,
        token: dead,
        repo: REPO,
        prId: 42,
        version: "v1",
      }),
    ).toEqual({ ok: false, reason: "expired" });
    const good = mintPreviewLinkToken({
      gatewaySecret: SECRET,
      repo: REPO,
      prId: 42,
      version: "v1",
      expiresAtMs: Date.now() + 60_000,
    });
    expect(
      verifyPreviewLinkToken({
        gatewaySecret: SECRET,
        token: `${good.slice(0, -1)}0`,
        repo: REPO,
        prId: 42,
        version: "v1",
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(
      verifyPreviewLinkToken({
        gatewaySecret: "other-secret",
        token: good,
        repo: REPO,
        prId: 42,
        version: "v1",
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("deny log names the reason without secret material", () => {
    const token = mintPreviewLinkToken({
      gatewaySecret: SECRET,
      repo: REPO,
      prId: 42,
      version: "v1",
      expiresAtMs: Date.now() + 60_000,
    });
    const line = authDenyLog({
      host: "pr-42.example.com",
      repo: REPO,
      prId: 42,
      reason: "expired",
    });
    expect(line).toContain("reason=expired");
    expect(line).not.toContain(token);
    expect(line).not.toContain(SECRET);
  });
});

describe("parseLinkExpiry", () => {
  test("defaults to 7d and parses durations", () => {
    const now = 1_700_000_000_000;
    const fallback = parseLinkExpiry(undefined, now);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.expiresAtMs).toBe(now + 7 * 86_400_000);
    }
    const hours = parseLinkExpiry("12h", now);
    expect(hours.ok).toBe(true);
    if (hours.ok) expect(hours.expiresAtMs).toBe(now + 12 * 3_600_000);
  });

  test("the past stays in the past for revocation tests", () => {
    const now = 1_700_000_000_000;
    const past = parseLinkExpiry("2000-01-01T00:00:00Z", now);
    expect(past.ok).toBe(true);
    if (past.ok) expect(past.expiresAtMs).toBeLessThan(now);
  });

  test("rejects garbage", () => {
    expect(parseLinkExpiry("soon").ok).toBe(false);
  });
});

describe("preview auth state", () => {
  test("middleware names stay per-preview", () => {
    expect(previewAuthMiddleware("myapp", 42)).toBe("sprout-myapp-pr-42-auth");
    expect(previewAuthMiddleware("myapp", 43)).not.toBe(
      previewAuthMiddleware("myapp", 42),
    );
  });

  test("basic credentials survive redeploys; link secrets stay put", () => {
    const basic = desiredPreviewAuthState({
      mode: "basic",
      stored: {
        authMode: "basic",
        authSecret: null,
        authBasicUser: "sprout",
        authBasicPassword: "pw",
      },
    });
    expect(basic.basicPassword).toBe("pw");
    const link = desiredPreviewAuthState({
      mode: "link",
      stored: {
        authMode: "link",
        authSecret: "v1",
        authBasicUser: null,
        authBasicPassword: null,
      },
    });
    expect(link.secret).toBe("v1");
  });

  test("mode switches mint fresh secrets and clear the old posture", () => {
    const switched = desiredPreviewAuthState({
      mode: "basic",
      stored: {
        authMode: "link",
        authSecret: "v1",
        authBasicUser: null,
        authBasicPassword: null,
      },
    });
    expect(switched.secret).toBeNull();
    expect(switched.basicPassword).not.toBeNull();
    const opened = desiredPreviewAuthState({
      mode: "none",
      stored: {
        authMode: "basic",
        authSecret: null,
        authBasicUser: "sprout",
        authBasicPassword: "pw",
      },
    });
    expect(opened).toEqual({
      mode: "none",
      secret: null,
      basicUser: null,
      basicPassword: null,
    });
  });

  test("generated secrets are unique and hash to htpasswd shape", async () => {
    expect(generatePreviewAuthSecret()).not.toBe(generatePreviewAuthSecret());
    expect(generateBasicPassword()).not.toBe(generateBasicPassword());
    const hash = await hashBasicPassword("pw");
    expect(hash.startsWith("$2y$")).toBe(true);
    expect(shareableLink("pr-42.example.com", "tok")).toBe(
      "https://pr-42.example.com/__sprout/auth?t=tok",
    );
  });
});
