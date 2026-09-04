import { expect } from "bun:test";
import { e2eConfig } from "./config.ts";

/** POST /v1/deploy request body (gateway contract for #25+). */
export type DeployRequest = {
  pr_id: number;
  slug: string;
  hostname: string;
  app_image: string;
  /** Omit for no-seed deploys; JSON.stringify drops undefined. */
  seed_image?: string;
  health: {
    path: string;
    interval_seconds: number;
    timeout_seconds: number;
    expect: number;
  };
};

export type DeployResponse = {
  db_name: string;
  status: string;
  preview_url?: string;
  container_id?: string;
  seeded_at?: string | null;
};

export type PreviewRow = {
  pr_id: number;
  db_name: string;
  status: string;
  container_id?: string | null;
};

export type PreviewsResponse = {
  previews: PreviewRow[];
};

export type TokensListResponse = {
  tokens: Array<{ scope: string; canonical_repo_id: string | null }>;
};

export type CreateTokenResponse = {
  token: string;
  id: string;
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

/** Assert an HTTP status is in the 2xx range (not merely < 300). */
export function expect2xx(status: number): void {
  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
}

export async function createDeployToken(input: {
  canonicalRepoId: string;
  slug: string;
  adminToken?: string;
}): Promise<CreateTokenResponse> {
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
  return (await res.json()) as CreateTokenResponse;
}

export async function readDeployResponse(
  res: Response,
): Promise<DeployResponse> {
  const body = (await res.json()) as DeployResponse;
  expect(typeof body.db_name).toBe("string");
  expect(typeof body.status).toBe("string");
  return body;
}

/**
 * Best-effort deploy body for when #25/#26 land. Shape follows the v0.1
 * gateway contract (slug/pr/image from adopting-repo CI). Adjust here if the
 * implementing tickets finalize a different schema — not in shared modules.
 *
 * Follow-up: switch to `@preview-buddy/api-client` once routes stabilize.
 */
export function deployBody(
  overrides: Partial<DeployRequest> = {},
): DeployRequest {
  const pr_id = overrides.pr_id ?? e2eConfig.prId;
  const slug = overrides.slug ?? e2eConfig.slug;
  const body: DeployRequest = {
    pr_id,
    slug,
    hostname:
      overrides.hostname ?? `pr-${pr_id}.${slug}.preview.example.com`,
    app_image: overrides.app_image ?? e2eConfig.demoAppImage,
    seed_image:
      "seed_image" in overrides
        ? overrides.seed_image
        : e2eConfig.demoSeedImage,
    health: overrides.health ?? {
      path: "/health",
      interval_seconds: 2,
      timeout_seconds: 120,
      expect: 200,
    },
  };
  return body;
}
