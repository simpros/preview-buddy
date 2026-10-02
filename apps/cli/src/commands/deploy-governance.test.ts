import { describe, expect, test } from "bun:test";
import type { SproutYaml } from "../yaml.ts";
import { buildDeployRequest } from "./deploy-core.ts";

const IDENTITY = { repo: "https://github.com/acme/widgets", prId: 7 };

function yaml(preview: SproutYaml["preview"]): SproutYaml {
  return { slug: "myapp", preview };
}

const MINIMAL_PREVIEW: SproutYaml["preview"] = {
  hostname: "pr-{pr_id}.example.com",
};

const INPUTS = {
  appImage: "img:latest",
  seedArg: [],
  service: [],
  clearServices: false,
};

describe("buildDeployRequest governance forwarding", () => {
  test("forwards ttl and idle_teardown when set", () => {
    const result = buildDeployRequest(
      yaml({ ...MINIMAL_PREVIEW, ttl: "7d", idle_teardown: "2h" }),
      IDENTITY,
      INPUTS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ttl).toBe("7d");
    expect(result.value.idle_teardown).toBe("2h");
  });

  test("forwards off verbatim", () => {
    const result = buildDeployRequest(
      yaml({ ...MINIMAL_PREVIEW, ttl: "off" }),
      IDENTITY,
      INPUTS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ttl).toBe("off");
    expect(result.value.idle_teardown).toBeUndefined();
  });

  test("omits both when absent", () => {
    const result = buildDeployRequest(yaml(MINIMAL_PREVIEW), IDENTITY, INPUTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ttl).toBeUndefined();
    expect(result.value.idle_teardown).toBeUndefined();
  });
});
