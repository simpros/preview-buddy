import { describe, expect, test } from "bun:test";
import { e2eConfig } from "./harness/config.ts";
import {
  createDeployToken,
  deployBody,
  gatewayFetch,
} from "./harness/gateway.ts";
import { loadE2eSession } from "./harness/session.ts";

const { enabled, caps } = await loadE2eSession();

/**
 * Full PR lifecycle against real compose. Skipped until POST /v1/deploy and
 * /v1/teardown leave the 501 stub (#25/#26/#27; seed path #28).
 */
describe.skipIf(!enabled)("preview lifecycle", () => {
  test.skipIf(!caps.deploy)(
    "PR-open path: preview row, prev_<slug>_pr<id>, container, URL loads",
    async () => {
      const { token } = await createDeployToken({
        canonicalRepoId: e2eConfig.canonicalRepoId,
        slug: e2eConfig.slug,
      });
      const expectedDb = `prev_${e2eConfig.slug}_pr${e2eConfig.prId}`;

      const deploy = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify(deployBody()),
      });
      expect(deploy.status).toBeLessThan(300);
      const deployJson = (await deploy.json()) as {
        preview_url?: string;
        db_name?: string;
        status?: string;
      };

      expect(deployJson.db_name).toBe(expectedDb);
      expect(deployJson.status).toBe("running");

      if (caps.previews) {
        const list = await gatewayFetch("/v1/previews", {
          method: "GET",
          token: e2eConfig.adminToken,
        });
        expect(list.status).toBe(200);
        const body = (await list.json()) as {
          previews: Array<{
            pr_id: number;
            db_name: string;
            status: string;
            container_id?: string | null;
          }>;
        };
        const row = body.previews.find((p) => p.pr_id === e2eConfig.prId);
        expect(row).toBeDefined();
        expect(row?.db_name).toBe(expectedDb);
        expect(row?.status).toBe("running");
        expect(row?.container_id).toBeTruthy();
      }

      const previewHost = `pr-${e2eConfig.prId}.${e2eConfig.slug}.preview.example.com`;
      const viaTraefik = await fetch(e2eConfig.traefikUrl, {
        headers: { host: previewHost },
      });
      expect(viaTraefik.ok).toBe(true);
    },
  );

  test.skipIf(!caps.deploy)(
    "synchronize path: container replaced, DB persists, seed skipped when seeded_at set",
    async () => {
      const slug = `${e2eConfig.slug}sync`;
      const { token } = await createDeployToken({
        canonicalRepoId: `${e2eConfig.canonicalRepoId}-sync`,
        slug,
      });
      const prId = e2eConfig.prId + 1;
      const expectedDb = `prev_${slug}_pr${prId}`;
      const body = deployBody({
        pr_id: prId,
        slug,
        hostname: `pr-${prId}.${slug}.preview.example.com`,
      });

      const first = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify(body),
      });
      expect(first.status).toBeLessThan(300);
      const firstJson = (await first.json()) as {
        container_id?: string;
        seeded_at?: string | null;
        db_name?: string;
      };
      expect(firstJson.db_name).toBe(expectedDb);
      expect(firstJson.container_id).toBeTruthy();

      const second = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify({
          ...body,
          app_image: `${e2eConfig.demoAppImage}-v2`,
        }),
      });
      expect(second.status).toBeLessThan(300);
      const secondJson = (await second.json()) as {
        container_id?: string;
        seeded_at?: string | null;
        db_name?: string;
      };

      expect(secondJson.db_name).toBe(expectedDb);
      expect(secondJson.container_id).toBeTruthy();
      expect(secondJson.container_id).not.toBe(firstJson.container_id);
      // Seed skip (#28): when first deploy recorded seeded_at, sync must keep it.
      if (firstJson.seeded_at) {
        expect(secondJson.seeded_at).toBe(firstJson.seeded_at);
      }
    },
  );

  test.skipIf(!caps.teardown)(
    "teardown path: DB dropped, container removed, status removed",
    async () => {
      const slug = `${e2eConfig.slug}td`;
      const { token } = await createDeployToken({
        canonicalRepoId: `${e2eConfig.canonicalRepoId}-td`,
        slug,
      });
      const prId = e2eConfig.prId + 2;
      expect(caps.deploy).toBe(true);

      const deploy = await gatewayFetch("/v1/deploy", {
        method: "POST",
        token,
        body: JSON.stringify(
          deployBody({
            pr_id: prId,
            slug,
            hostname: `pr-${prId}.${slug}.preview.example.com`,
            seed_image: undefined,
          }),
        ),
      });
      expect(deploy.status).toBeLessThan(300);

      const teardown = await gatewayFetch("/v1/teardown", {
        method: "POST",
        token,
        body: JSON.stringify({ pr_id: prId }),
      });
      expect(teardown.status).toBeLessThan(300);

      if (caps.previews) {
        const list = await gatewayFetch("/v1/previews", {
          method: "GET",
          token: e2eConfig.adminToken,
        });
        const body = (await list.json()) as {
          previews: Array<{
            pr_id: number;
            status: string;
            container_id?: string | null;
          }>;
        };
        const row = body.previews.find((p) => p.pr_id === prId);
        expect(row?.status).toBe("removed");
        expect(row?.container_id == null || row.container_id === "").toBe(true);
      }
    },
  );
});
