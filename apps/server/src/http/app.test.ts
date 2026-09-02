import { describe, expect, test } from "bun:test";
import { createRoutes } from "./routes.ts";

describe("createRoutes", () => {
  test("GET /healthz returns ok without auth", async () => {
    const res = await createRoutes().handle(
      new Request("http://localhost/healthz"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /v1 and /v1/* return 501 stub", async () => {
    for (const path of ["/v1", "/v1/deploy"]) {
      const res = await createRoutes().handle(
        new Request(`http://localhost${path}`),
      );
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "not implemented" });
    }
  });
});
