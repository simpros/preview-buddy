import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";
import {
  createDeployToken,
  gatewayFetch,
  type TokensListResponse,
} from "./harness/gateway.ts";
import { loadE2eSession } from "./harness/session.ts";

const { enabled } = await loadE2eSession();

describe.skipIf(!enabled)("compose stack", () => {
  test("GET /healthz is reachable on the e2e gateway", async () => {
    const res = await gatewayFetch("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("admin token can create a deploy token", async () => {
    const created = await createDeployToken({
      canonicalRepoId: e2eConfig.canonicalRepoId,
      slug: e2eConfig.slug,
    });
    expect(created.token.length).toBeGreaterThan(8);

    const list = await gatewayFetch("/v1/admin/tokens", {
      method: "GET",
      token: e2eConfig.adminToken,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as TokensListResponse;
    expect(
      body.tokens.some(
        (t) =>
          t.scope === "deploy" &&
          t.canonical_repo_id === e2eConfig.canonicalRepoId,
      ),
    ).toBe(true);
  });
});
