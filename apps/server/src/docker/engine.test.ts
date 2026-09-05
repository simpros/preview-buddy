import { describe, expect, test } from "bun:test";
import {
  createDockerEngineClient,
  firstExposedPortFromInspect,
  splitImageRef,
} from "./engine.ts";

describe("splitImageRef", () => {
  test("splits tag after last colon past slash", () => {
    expect(splitImageRef("ghcr.io/org/app:sha-abc")).toEqual({
      fromImage: "ghcr.io/org/app",
      tag: "sha-abc",
    });
  });

  test("defaults tag to latest", () => {
    expect(splitImageRef("ghcr.io/org/app")).toEqual({
      fromImage: "ghcr.io/org/app",
      tag: "latest",
    });
  });
});

describe("firstExposedPortFromInspect", () => {
  test("returns first EXPOSE port", () => {
    expect(
      firstExposedPortFromInspect({
        Config: { ExposedPorts: { "3000/tcp": {}, "443/tcp": {} } },
      }),
    ).toBe(3000);
  });

  test("returns null when no EXPOSE", () => {
    expect(firstExposedPortFromInspect({ Config: {} })).toBeNull();
  });
});

describe("createDockerEngineClient", () => {
  test("createAndStart posts create, connects extra network, starts", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const docker = createDockerEngineClient({
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, method, body });
        if (url.includes("/containers/create")) {
          return new Response(JSON.stringify({ Id: "cid-1" }), { status: 201 });
        }
        if (url.includes("/networks/") && url.includes("/connect")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("/start")) {
          return new Response(null, { status: 204 });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    const { id } = await docker.createAndStart({
      name: "pb-myapp-pr-1",
      image: "img:1",
      env: ["PGHOST=postgres"],
      labels: { "traefik.enable": "true" },
      networkNames: ["traefik", "postgres"],
    });
    expect(id).toBe("cid-1");
    expect(calls.map((c) => c.method + " " + c.url)).toEqual([
      "POST http://localhost/containers/create?name=pb-myapp-pr-1",
      "POST http://localhost/networks/postgres/connect",
      "POST http://localhost/containers/cid-1/start",
    ]);
    const createBody = JSON.parse(calls[0]!.body!);
    expect(createBody.HostConfig.NetworkMode).toBe("traefik");
    expect(createBody.NetworkingConfig.EndpointsConfig).toEqual({
      traefik: {},
      postgres: {},
    });
    expect(createBody.Env).toEqual(["PGHOST=postgres"]);
  });

  test("removeByName treats 404 as success", async () => {
    const docker = createDockerEngineClient({
      fetch: async () => new Response(null, { status: 404 }),
    });
    await docker.removeByName("pb-gone-pr-1");
  });

  test("pullImage sends registry auth when configured", async () => {
    const seen: { auth: string | null } = { auth: null };
    const docker = createDockerEngineClient({
      registryAuth: { username: "u", password: "p" },
      fetch: async (_input, init) => {
        seen.auth = new Headers(init?.headers).get("X-Registry-Auth");
        return new Response("{}", { status: 200 });
      },
    });
    await docker.pullImage("ghcr.io/org/app:tag");
    expect(seen.auth).toBe(
      Buffer.from(JSON.stringify({ username: "u", password: "p" })).toString(
        "base64",
      ),
    );
  });
});
