import { afterEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { connectState } from "../src/db.ts";
import { createServer } from "../src/server.ts";

const testConfig: Config = {
  previewPostgresUrl: "postgres://admin@localhost:5432/postgres",
  traefikNetwork: "traefik",
  postgresNetwork: "postgres",
  registryUrl: "registry.example.com",
  registryUser: "puller",
  registryPassword: "secret",
  ttlHours: 72,
  sweepMinutes: 30,
  previewPortDefault: 8080,
  seedTimeout: 180,
  port: 7331,
};

let stateDb = connectState(":memory:");

afterEach(async () => {
  await stateDb.close();
  stateDb = connectState(":memory:");
});

function app() {
  return createServer({ config: testConfig, state: stateDb });
}

describe("createServer", () => {
  test("GET /healthz returns ok without auth", async () => {
    const res = await app().handle(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /v1 and /v1/* return 501 stub", async () => {
    for (const path of ["/v1", "/v1/deploy"]) {
      const res = await app().handle(new Request(`http://localhost${path}`));
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "not implemented" });
    }
  });
});
