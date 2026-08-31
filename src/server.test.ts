import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
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

describe("createServer", () => {
  test("GET /healthz returns ok without auth", async () => {
    const app = createServer({ config: testConfig });
    const res = await app.handle(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
