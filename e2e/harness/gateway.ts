import { e2eConfig } from "./config.ts";

export type GatewayCapabilities = {
  /** POST /v1/deploy is no longer a 501 stub (#25+). */
  deploy: boolean;
  /** POST /v1/teardown is no longer a 501 stub (#25+). */
  teardown: boolean;
  /** GET /v1/previews is no longer a 501 stub (#31). */
  previews: boolean;
  /** GET /v1/doctor is no longer a 501 stub (#31). */
  doctor: boolean;
};

function bearer(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export async function gatewayFetch(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetch(`${e2eConfig.gatewayUrl}${path}`, {
    ...rest,
    headers: {
      ...(token ? bearer(token) : {}),
      ...headers,
    },
  });
}

/** Probe stubs: 501 means the feature ticket has not landed yet. */
export async function probeCapabilities(
  adminToken = e2eConfig.adminToken,
): Promise<GatewayCapabilities> {
  const [deploy, teardown, previews, doctor] = await Promise.all([
    gatewayFetch("/v1/deploy", { method: "POST", token: adminToken, body: "{}" }),
    gatewayFetch("/v1/teardown", {
      method: "POST",
      token: adminToken,
      body: "{}",
    }),
    gatewayFetch("/v1/previews", { method: "GET", token: adminToken }),
    gatewayFetch("/v1/doctor", { method: "GET", token: adminToken }),
  ]);

  return {
    deploy: deploy.status !== 501,
    teardown: teardown.status !== 501,
    previews: previews.status !== 501,
    doctor: doctor.status !== 501,
  };
}

export async function createDeployToken(input: {
  canonicalRepoId: string;
  slug: string;
  adminToken?: string;
}): Promise<{ token: string; id: string }> {
  const res = await gatewayFetch("/v1/admin/tokens", {
    method: "POST",
    token: input.adminToken ?? e2eConfig.adminToken,
    body: JSON.stringify({
      canonical_repo_id: input.canonicalRepoId,
      slug: input.slug,
    }),
  });
  if (res.status !== 201) {
    throw new Error(
      `create deploy token failed: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { token: string; id: string };
  return { token: body.token, id: body.id };
}

/**
 * Best-effort deploy body for when #25/#26 land. Shape follows the v0.1
 * gateway contract (slug/pr/image from adopting-repo CI). Adjust here if the
 * implementing tickets finalize a different schema — not in shared modules.
 */
export function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    pr_id: e2eConfig.prId,
    slug: e2eConfig.slug,
    hostname: `pr-${e2eConfig.prId}.${e2eConfig.slug}.preview.example.com`,
    app_image: e2eConfig.demoAppImage,
    seed_image: e2eConfig.demoSeedImage,
    health: {
      path: "/health",
      interval_seconds: 2,
      timeout_seconds: 120,
      expect: 200,
    },
    ...overrides,
  };
}
