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
 * Sweep orphan scenario. Requires deploy (#25+) so an intentional orphan can
 * exist, plus sweep (#30) / doctor (#31). Uses the recorded GitHub empty
 * open-PR fixture as forge truth once a sweep trigger exists.
 *
 * Fixture shape lives in fixtures.test.ts; this file is the compose path.
 */
describe.skipIf(!enabled)("sweep orphan", () => {
  // Incomplete until #30 exposes a sweep-trigger endpoint (admin sweep or
  // forge client fed fixtures/forge/github-orphan-no-open-prs.json).
  test.todo("sweep trigger pending #30");

  test.skipIf(!caps.deploy || !caps.doctor)(
    "sweep drops intentional orphan when forge reports no open PRs",
    async () => {
      const slug = `${e2eConfig.slug}orphan`;
      const { token } = await createDeployToken({
        canonicalRepoId: `${e2eConfig.canonicalRepoId}-orphan`,
        slug,
      });
      const prId = 99;
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

      // TODO(#30): trigger sweep with forge truth from
      // fixtures/forge/github-orphan-no-open-prs.json, then assert below.

      const doctor = await gatewayFetch("/v1/doctor", {
        method: "GET",
        token: e2eConfig.adminToken,
      });
      expect(doctor.status).toBe(200);
      const report = (await doctor.json()) as {
        orphans?: Array<{ pr_id: number }>;
        previews?: Array<{ pr_id: number; status: string }>;
      };
      // After sweep: intentional orphan must not remain running.
      if (Array.isArray(report.previews)) {
        const row = report.previews.find((p) => p.pr_id === prId);
        expect(row === undefined || row.status === "removed").toBe(true);
      }
      if (Array.isArray(report.orphans)) {
        expect(report.orphans.some((o) => o.pr_id === prId)).toBe(false);
      }
    },
  );
});
