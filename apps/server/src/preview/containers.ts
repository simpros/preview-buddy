import {
  createDockerEngineClient,
  dockerAsContainerPorts,
  type DockerEngineOptions,
} from "../docker/engine.ts";
import type { CatalogContainer } from "../docker/port.ts";

export type { CatalogContainer };

export type ContainerPorts = {
  listPreviewContainers: () => Promise<CatalogContainer[]>;
  remove: (opts: { slug: string; prId: number }) => Promise<void>;
};

export type DockerRemoverOptions = DockerEngineOptions;

/** Minimal Docker engine list + remove by preview container name. */
export function createDockerRemover(
  options: DockerRemoverOptions = {},
): ContainerPorts {
  return dockerAsContainerPorts(createDockerEngineClient(options));
}
