import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";
import {
  createDeployToken,
  deployBody,
  expect2xx,
  gatewayFetch,
  readDeployResponse,
  type PreviewsResponse,
} from "./harness/gateway.ts";
import { isE2eFull, loadE2eSession } from "./harness/session.ts";

const session = await loadE2eSession();
const full = session.enabled && isE2eFull();

/**
 * Full PR lifecycle against real compose. Gated on PB_E2E_FULL=1 until
 * POST /v1/deploy, /v1/teardown, /v1/previews, and seed (#25–#28, #31) exist.
 */
describe.skipIf(!full)("preview lifecycle", () => {
  test(
    "PR-open path: preview row, prev_<slug>_pr<id>, container, URL loads",
    async () => {
      const { token } = await createDeployToken({
        canonicalRepoId: e2eConfig.canonicalRepoId,
        slug: e2eConfig.slug,
      });
      const body = deployBody();
      const expectedDb = `prev_${e2eConfig.slug}_pr${e2eConfig.prId}`;

      const deploy = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify(body),
      });
      expect2xx(deploy.status);
      const deployJson = await readDeployResponse(deploy);

      expect(deployJson.db_name).toBe(expectedDb);
      expect(deployJson.status).toBe("running");

      const list = await gatewayFetch("/v1/previews", {
        method: "GET",
        token: e2eConfig.adminToken,
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as PreviewsResponse;
      const row = listBody.previews.find((p) => p.pr_id === e2eConfig.prId);
      expect(row).toBeDefined();
      expect(row?.db_name).toBe(expectedDb);
      expect(row?.status).toBe("running");
      expect(row?.container_id).toBeTruthy();

      const viaTraefik = await fetch(e2eConfig.traefikUrl, {
        headers: { host: body.hostname },
      });
      expect(viaTraefik.ok).toBe(true);
    },
  );

  test(
    "synchronize path: container replaced, DB persists, seed skipped when seeded_at set",
    async () => {
      const slug = `${e2eConfig.slug}sync`;
      const { token } = await createDeployToken({
        canonicalRepoId: `${e2eConfig.canonicalRepoId}-sync`,
        slug,
      });
      const prId = e2eConfig.prId + 1;
      const expectedDb = `prev_${slug}_pr${prId}`;
      const body = deployBody({ pr_id: prId, slug });

      const first = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify(body),
      });
      expect2xx(first.status);
      const firstJson = await readDeployResponse(first);
      expect(firstJson.db_name).toBe(expectedDb);
      expect(firstJson.container_id).toBeTruthy();
      expect(firstJson.seeded_at).toBeTruthy();

      // Same image as first deploy — harness only builds :app / :seed.
      const second = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify(body),
      });
      expect2xx(second.status);
      const secondJson = await readDeployResponse(second);

      expect(secondJson.db_name).toBe(expectedDb);
      expect(secondJson.container_id).toBeTruthy();
      expect(secondJson.container_id).not.toBe(firstJson.container_id);
      expect(secondJson.seeded_at).toBe(firstJson.seeded_at);
    },
  );

  test("teardown path: DB dropped, container removed, status removed", async () => {
    const slug = `${e2eConfig.slug}td`;
    const { token } = await createDeployToken({
      canonicalRepoId: `${e2eConfig.canonicalRepoId}-td`,
      slug,
    });
    const prId = e2eConfig.prId + 2;

    const deploy = await gatewayFetch("/v1/deploy", {
      method: "POST",
      token,
      body: JSON.stringify(
        deployBody({
          pr_id: prId,
          slug,
          seed_image: undefined,
        }),
      ),
    });
    expect2xx(deploy.status);
    await readDeployResponse(deploy);

    const teardown = await gatewayFetch("/v1/teardown", {
      method: "POST",
      token,
      body: JSON.stringify({ pr_id: prId }),
    });
    expect2xx(teardown.status);

    const list = await gatewayFetch("/v1/previews", {
      method: "GET",
      token: e2eConfig.adminToken,
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as PreviewsResponse;
    const row = listBody.previews.find((p) => p.pr_id === prId);
    expect(row?.status).toBe("removed");
    expect(row?.container_id == null || row.container_id === "").toBe(true);
  });
});
