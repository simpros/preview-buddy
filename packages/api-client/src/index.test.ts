import { describe, expect, test } from "bun:test";
import { createApiClient } from "./index.ts";

describe("createApiClient", () => {
  test("exposes typed healthz route", () => {
    const client = createApiClient("http://localhost:7331");
    expect(typeof client.healthz.get).toBe("function");
  });
});
