import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGatewayUrl } from "./gateway-url.ts";

describe("resolveGatewayUrl", () => {
  test("uses PBUDDY_URL when set", () => {
    expect(resolveGatewayUrl({ PBUDDY_URL: "https://pb.example.com" })).toBe(
      "https://pb.example.com",
    );
  });

  test("defaults to local gateway when PBUDDY_URL is unset or blank", () => {
    expect(resolveGatewayUrl({})).toBe("http://127.0.0.1:7331");
    expect(resolveGatewayUrl({ PBUDDY_URL: "  " })).toBe(
      "http://127.0.0.1:7331",
    );
  });
});

describe("release surface", () => {
  const rootPkg = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"),
  ) as { version?: string; scripts?: Record<string, string> };

  test("root package version is 0.1.0", () => {
    expect(rootPkg.version).toBe("0.1.0");
  });

  test("root package.json exposes bun run pbuddy", () => {
    expect(rootPkg.scripts?.pbuddy).toBeTruthy();
  });
});
