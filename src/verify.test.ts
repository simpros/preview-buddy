import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  verifyGitHubSignature,
  verifyGitLabToken,
} from "../src/verify.ts";

describe("verifyGitHubSignature", () => {
  const secret = "test-secret";
  const body = '{"action":"opened"}';

  test("accepts valid HMAC", () => {
    const sig = `sha256=${createHmac("sha256", secret)
      .update(body, "utf8")
      .digest("hex")}`;
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });

  test("rejects invalid HMAC", () => {
    expect(
      verifyGitHubSignature(body, "sha256=deadbeef", secret),
    ).toBe(false);
  });

  test("rejects missing secret or header", () => {
    expect(verifyGitHubSignature(body, null, secret)).toBe(false);
    expect(verifyGitHubSignature(body, "sha256=abc", "")).toBe(false);
  });
});

describe("verifyGitLabToken", () => {
  test("accepts matching token", () => {
    expect(verifyGitLabToken("my-token", "my-token")).toBe(true);
  });

  test("rejects mismatched token", () => {
    expect(verifyGitLabToken("wrong", "my-token")).toBe(false);
  });

  test("rejects missing token or secret", () => {
    expect(verifyGitLabToken(null, "secret")).toBe(false);
    expect(verifyGitLabToken("token", "")).toBe(false);
  });
});
