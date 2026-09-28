import { describe, expect, test } from "bun:test";
import type { CliContext } from "../context.ts";
import type { SproutYaml } from "../yaml.ts";
import {
  prepareServiceImages,
  resolveServiceImageRef,
  resolveServiceImageTargets,
  serviceFlagOverrides,
} from "./service-image.ts";

const APP_REF = "registry.example.com/group/app:abc123";

function yamlWithServices(
  services: SproutYaml["preview"]["services"],
): SproutYaml {
  return {
    slug: "myapp",
    preview: {
      hostname: "pr-{pr_id}.example.com",
      services,
    },
  };
}

function fakeCtx(): { ctx: CliContext; calls: string[][] } {
  const calls: string[][] = [];
  const ctx = {
    deps: {
      env: {},
      cwd: "/repo",
      readTextFile: async () => null,
      getGitRemoteUrl: () => null,
      createClient: () => {
        throw new Error("unused");
      },
      runCommand: async (argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0 };
      },
      io: { stdout: () => {}, stderr: () => {} },
    },
    client: {},
  } as unknown as CliContext;
  return { ctx, calls };
}

describe("resolveServiceImageRef", () => {
  test("mirrors the seed <app-ref>-suffix shape", () => {
    expect(resolveServiceImageRef(APP_REF, "landing")).toEqual({
      ok: true,
      value: "registry.example.com/group/app:abc123-landing",
    });
  });

  test("keeps the repository path so scoped credentials keep working", () => {
    const ref = resolveServiceImageRef(APP_REF, "landing");
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect(ref.value.split(":")[0]).toBe("registry.example.com/group/app");
  });

  test("refuses an untagged app ref", () => {
    expect(resolveServiceImageRef("registry/app", "landing").ok).toBe(false);
  });

  test("refuses a service name that would overflow the tag limit", () => {
    expect(resolveServiceImageRef(APP_REF, "x".repeat(200)).ok).toBe(false);
  });
});

describe("serviceFlagOverrides", () => {
  test("collects overridden names", () => {
    expect(serviceFlagOverrides(["a=img:1", "b=img:2"])).toEqual({
      ok: true,
      value: new Set(["a", "b"]),
    });
  });

  test("rejects malformed flags", () => {
    expect(serviceFlagOverrides(["nope"]).ok).toBe(false);
  });
});

describe("resolveServiceImageTargets", () => {
  test("targets every dockerfile service not overridden", () => {
    const yaml = yamlWithServices([
      { name: "landing", dockerfile: "apps/landing/Dockerfile" },
      { name: "api", image: "api:1" },
    ]);
    expect(
      resolveServiceImageTargets(yaml, APP_REF, new Set(["other"])),
    ).toEqual({
      ok: true,
      value: new Map([
        [
          "landing",
          {
            dockerfile: "apps/landing/Dockerfile",
            ref: `${APP_REF}-landing`,
          },
        ],
      ]),
    });
  });

  test("skips dockerfile services overridden by --service", () => {
    const yaml = yamlWithServices([
      { name: "landing", dockerfile: "apps/landing/Dockerfile" },
    ]);
    expect(
      resolveServiceImageTargets(yaml, APP_REF, new Set(["landing"])),
    ).toEqual({ ok: true, value: new Map() });
  });

  test("no dockerfile services means no targets (inert by default)", () => {
    const yaml = yamlWithServices([{ name: "api", image: "api:1" }]);
    expect(resolveServiceImageTargets(yaml, APP_REF, new Set())).toEqual({
      ok: true,
      value: new Map(),
    });
  });
});

describe("prepareServiceImages", () => {
  test("builds + pushes each declared service image", async () => {
    const { ctx, calls } = fakeCtx();
    const yaml = yamlWithServices([
      {
        name: "landing",
        hostname: "landing-pr-{pr_id}.example.com",
        dockerfile: "apps/landing/Dockerfile",
      },
    ]);
    const result = await prepareServiceImages(
      ctx,
      yaml,
      APP_REF,
      { service: [], clearServices: false },
      { build: true },
    );
    expect(result).toEqual({
      ok: true,
      value: new Map([
        [
          "landing",
          {
            dockerfile: "apps/landing/Dockerfile",
            ref: `${APP_REF}-landing`,
          },
        ],
      ]),
    });
    expect(calls).toEqual([
      [
        "docker",
        "build",
        "-f",
        "apps/landing/Dockerfile",
        "-t",
        `${APP_REF}-landing`,
        ".",
      ],
      ["docker", "push", `${APP_REF}-landing`],
    ]);
    // The map is the transport: the yaml stays untouched for the request layer.
    expect(yaml.preview.services?.[0]).not.toHaveProperty("image");
  });

  test("build: false resolves the same refs with no docker work", async () => {
    const { ctx, calls } = fakeCtx();
    const yaml = yamlWithServices([
      { name: "landing", dockerfile: "apps/landing/Dockerfile" },
    ]);
    const result = await prepareServiceImages(
      ctx,
      yaml,
      APP_REF,
      { service: [], clearServices: false },
      { build: false },
    );
    expect(result).toEqual({
      ok: true,
      value: new Map([
        [
          "landing",
          {
            dockerfile: "apps/landing/Dockerfile",
            ref: `${APP_REF}-landing`,
          },
        ],
      ]),
    });
    expect(calls).toEqual([]);
    expect(yaml.preview.services?.[0]).not.toHaveProperty("image");
  });

  test("--clear-services skips all builds", async () => {
    const { ctx, calls } = fakeCtx();
    const yaml = yamlWithServices([
      { name: "landing", dockerfile: "apps/landing/Dockerfile" },
    ]);
    const result = await prepareServiceImages(
      ctx,
      yaml,
      APP_REF,
      { service: [], clearServices: true },
      { build: true },
    );
    expect(result).toEqual({ ok: true, value: new Map() });
    expect(calls).toEqual([]);
  });

  test("--service overlay skips the overridden build", async () => {
    const { ctx, calls } = fakeCtx();
    const yaml = yamlWithServices([
      { name: "landing", dockerfile: "apps/landing/Dockerfile" },
    ]);
    const result = await prepareServiceImages(
      ctx,
      yaml,
      APP_REF,
      { service: ["landing=prebuilt:1"], clearServices: false },
      { build: true },
    );
    expect(result).toEqual({ ok: true, value: new Map() });
    expect(calls).toEqual([]);
  });

  test("build failure propagates with the service label", async () => {
    const calls: string[][] = [];
    const ctx = {
      deps: {
        env: {},
        cwd: "/repo",
        readTextFile: async () => null,
        getGitRemoteUrl: () => null,
        createClient: () => {
          throw new Error("unused");
        },
        runCommand: async (argv: string[]) => {
          calls.push(argv);
          return { exitCode: 2 };
        },
        io: { stdout: () => {}, stderr: () => {} },
      },
      client: {},
    } as unknown as CliContext;
    const yaml = yamlWithServices([
      { name: "landing", dockerfile: "apps/landing/Dockerfile" },
    ]);
    const result = await prepareServiceImages(
      ctx,
      yaml,
      APP_REF,
      { service: [], clearServices: false },
      { build: true },
    );
    expect(result).toEqual({
      ok: false,
      error: "service landing image build failed (exit 2)",
    });
    expect(calls).toHaveLength(1);
  });
});
