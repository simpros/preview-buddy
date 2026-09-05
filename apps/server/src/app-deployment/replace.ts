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
  previewPortDefault: number;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  dbName: string;
};

/**
 * Replace (or first-start) the preview app container for one PR.
 * Pulls the image, force-removes any prior container with the stable name,
 * then creates+starts with dual-network attach, Traefik labels, and PG* env only.
 */
export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  await deps.docker.pullImage(input.image);
  const exposed = await deps.docker.firstExposedPort(input.image);
  const port = exposed ?? deps.previewPortDefault;
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
      port,
    }),
    networkNames: [deps.networks.traefik, deps.networks.postgres],
  });
  return { containerId: id, port };
}
