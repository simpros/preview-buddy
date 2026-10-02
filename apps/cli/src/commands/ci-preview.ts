import type { ApiClient } from "@sprout/api-client";
import type { CliContext } from "../context.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import { runCiDeploy, type CiDeployPolicy } from "./ci-deploy.ts";
import { publishPreviewNote } from "./forge-note.ts";
import { fetchPreviewAccess } from "./access.ts";
import { buildAndPush } from "./image-build.ts";
import { ensureSeedImage } from "./seed-image.ts";
import type { SproutYaml } from "../yaml.ts";

export const previewDeployPolicy: CiDeployPolicy = {
  allowReseed: true,
  prepareImages: async (ctx, yaml, identity) => {
    let seedImage: string | undefined;
    if (yaml.seed) {
      const seed = await ensureSeedImage(ctx, yaml.seed, identity.imageRef);
      if (!seed.ok) return seed;
      seedImage = seed.value.ref;
    }
    const appDockerfile = yaml.build?.dockerfile ?? "Dockerfile";
    const app = await buildAndPush(ctx, "app", appDockerfile, identity.imageRef);
    if (!app.ok) return app;
    return { ok: true, value: { seedImage } };
  },
  publishNote: (deps, identity, settled, extra?: { client: ApiClient; yaml: SproutYaml }) =>
    publishPreviewNoteWithAccess(deps, identity, settled, extra),
};

async function publishPreviewNoteWithAccess(
  deps: import("../context.ts").CliDeps,
  identity: import("./ci-identity.ts").CiIdentity,
  settled: import("./deploy-outcome.ts").DeploySettled & { reset?: boolean },
  extra?: { client: ApiClient; yaml: SproutYaml },
) {
  const mode = extra?.yaml.preview.auth?.mode ?? "none";
  if (mode === "basic" && extra) {
    const access = await fetchPreviewAccess(extra.client, {
      repo: identity.repo,
      prId: identity.prId,
    });
    if (access.ok && access.value.auth === "basic") {
      return publishPreviewNote(deps, identity, {
        ...settled,
        credential: {
          username: access.value.username,
          password: access.value.password,
        },
      });
    }
    deps.io.stderr(
      `warning: preview access lookup failed: ${access.ok ? "unexpected response" : access.error}`,
    );
    return publishPreviewNote(deps, identity, settled);
  }
  if (mode === "link") {
    return publishPreviewNote(deps, identity, {
      ...settled,
      gatedLink: true,
    });
  }
  return publishPreviewNote(deps, identity, settled);
}

export async function runCiPreview(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  return runCiDeploy(identity, tokens, ctx, previewDeployPolicy);
}
