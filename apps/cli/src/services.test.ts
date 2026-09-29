import { describe, expect, test } from "bun:test";
import {
  mergeServices,
  parseServiceFlag,
  resolveServiceImages,
} from "./services.ts";
import type { AppEnvResolveContext } from "./app-env-values.ts";

const ctx: AppEnvResolveContext = {
  hostname: "pr-9.example.com",
  prId: 9,
  commitSha: "deadbeef",
  repo: "org/repo",
  deployToken: "t",
};

describe("parseServiceFlag", () => {
  test("parses name=image", () => {
    expect(parseServiceFlag("api=ghcr.io/org/api:sha")).toEqual({
      ok: true,
      value: { name: "api", image: "ghcr.io/org/api:sha" },
    });
  });

  test("rejects invalid shapes", () => {
    expect(parseServiceFlag("api").ok).toBe(false);
    expect(parseServiceFlag("=image").ok).toBe(false);
    expect(parseServiceFlag("API=image").ok).toBe(false);
    expect(parseServiceFlag("api=").ok).toBe(false);
  });
});

describe("mergeServices", () => {
  test("merges yaml routing with CLI images", () => {
    expect(
      mergeServices(
        [
          {
            name: "api",
            hostname: "api-pr-{pr_id}.example.com",
          },
          { name: "worker" },
        ],
        ["api=ghcr.io/org/api:1", "worker=ghcr.io/org/worker:1"],
      ),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "api",
          image: "ghcr.io/org/api:1",
          hostname: "api-pr-{pr_id}.example.com",
        },
        { name: "worker", image: "ghcr.io/org/worker:1" },
      ],
    });
  });

  test("CLI-only services need no yaml", () => {
    expect(mergeServices(undefined, ["api=img:1"])).toEqual({
      ok: true,
      value: [{ name: "api", image: "img:1" }],
    });
  });

  test("fails when yaml service has no image after merge", () => {
    expect(mergeServices([{ name: "api" }], [])).toEqual({
      ok: false,
      error: "service api requires an image (--service api=<image>)",
    });
  });

  test("rejects more than MAX_SERVICES", () => {
    const flags = Array.from(
      { length: 9 },
      (_, i) => `svc${i}=img:${i}`,
    );
    expect(mergeServices(undefined, flags)).toEqual({
      ok: false,
      error: "at most 8 services",
    });
  });

  test("carries yaml labels through the merge", () => {
    expect(
      mergeServices(
        [
          {
            name: "api",
            image: "api:1",
            labels: { "com.example.backup": "true" },
          },
        ],
        [],
      ),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "api",
          image: "api:1",
          labels: { "com.example.backup": "true" },
        },
      ],
    });
  });
});

describe("resolveServiceImages", () => {
  test("resolves {commit_sha} and {pr_id}", () => {
    expect(
      resolveServiceImages(
        [{ name: "landing", image: "ghcr.io/org/landing:{commit_sha}-pr-{pr_id}" }],
        ctx,
      ),
    ).toEqual({
      ok: true,
      value: [{ name: "landing", image: "ghcr.io/org/landing:deadbeef-pr-9" }],
    });
  });

  test("{hostname} prefers the service hostname over the app hostname", () => {
    expect(
      resolveServiceImages(
        [
          {
            name: "landing",
            image: "ghcr.io/org/landing:{hostname}",
            hostname: "landing-pr-9.example.com",
          },
          { name: "plain", image: "ghcr.io/org/plain:{hostname}" },
        ],
        ctx,
      ),
    ).toEqual({
      ok: true,
      value: [
        { name: "landing", image: "ghcr.io/org/landing:landing-pr-9.example.com", hostname: "landing-pr-9.example.com" },
        { name: "plain", image: "ghcr.io/org/plain:pr-9.example.com" },
      ],
    });
  });

  test("literal refs stay byte-identical", () => {
    expect(
      resolveServiceImages([{ name: "api", image: "ghcr.io/org/api:1.2.3" }], ctx),
    ).toEqual({
      ok: true,
      value: [{ name: "api", image: "ghcr.io/org/api:1.2.3" }],
    });
  });

  test("unknown placeholder fails with the service index", () => {
    expect(
      resolveServiceImages(
        [
          { name: "ok", image: "img:1" },
          { name: "landing", image: "ghcr.io/org/landing:{foo}" },
        ],
        ctx,
      ),
    ).toEqual({
      ok: false,
      error: "preview.services[1].image: unknown placeholder {foo}",
    });
  });

  test("missing SHA fails with the service index", () => {
    expect(
      resolveServiceImages(
        [{ name: "landing", image: "ghcr.io/org/landing:{commit_sha}" }],
        { ...ctx, commitSha: undefined },
      ),
    ).toEqual({
      ok: false,
      error:
        "preview.services[0].image: {commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA",
    });
  });
});
