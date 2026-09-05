import { traefikLabels } from "./labels.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewContainerName } from "../preview/naming.ts";

export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export type AppDeployNetworks = {
  traefik: string;
  postgres: string;
};

export type ReplacePreviewAppDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: AppDeployNetworks;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  dbName: string;
  /** Resolved by preparePreviewImage (pull + inspect) outside the preview lock. */
  port: number;
};

/**
 * Registry pull + EXPOSE inspect. Call outside the preview lock so a hung
 * registry cannot stall teardown for the same (repo, prId).
 */
export async function preparePreviewImage(
  docker: PreviewDocker,
  image: string,
  previewPortDefault: number,
): Promise<number> {
  await docker.pullImage(image);
  const exposed = await docker.firstExposedPort(image);
  return exposed ?? previewPortDefault;
}

/**
 * Replace (or first-start) the preview app container for one PR.
 * Force-removes any prior container with the stable name, then creates+starts
 * with dual-network attach, Traefik labels, and PG* env only.
 * Caller must already have pulled via preparePreviewImage.
 */
export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  const name = previewContainerName(input.slug, input.prId);
  await deps.docker.removeByName(name);
  const { id } = await deps.docker.createAndStart({
    name,
    image: input.image,
    env: [
      `PGHOST=${deps.pg.host}`,
      `PGPORT=${String(deps.pg.port)}`,
      `PGUSER=${deps.pg.user}`,
      `PGPASSWORD=${deps.pg.password}`,
      `PGDATABASE=${input.dbName}`,
    ],
    labels: traefikLabels({
      routerName: name,
      hostname: input.hostname,
      port: input.port,
    }),
    networkNames: [deps.networks.traefik, deps.networks.postgres],
  });
  return { containerId: id, port: input.port };
}
