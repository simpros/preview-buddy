import { afterEach, describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { createApp } from "../http/app.ts";
import { connectState } from "../infrastructure/db/client.ts";

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

let state = connectState(":memory:");

afterEach(async () => {
  await state.sql.close();
  state = connectState(":memory:");
});

function app() {
  return createApp({ config: testConfig, db: state.db });
}

describe("createApp", () => {
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
