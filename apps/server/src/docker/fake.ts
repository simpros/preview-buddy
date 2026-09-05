import { parsePreviewContainerName } from "../preview/naming.ts";
import type {
  CatalogContainer,
  ContainerCreateSpec,
  DockerClient,
} from "./port.ts";

export type FakeDockerClient = DockerClient & {
  pulls: string[];
  creates: ContainerCreateSpec[];
  removed: string[];
  /** Image → first exposed port; unset images return null. */
  exposedPorts: Map<string, number | null>;
  running: Map<string, { id: string; spec: ContainerCreateSpec }>;
};

export function createFakeDockerClient(
  options: {
    exposedPorts?: Record<string, number | null>;
  } = {},
): FakeDockerClient {
  const pulls: string[] = [];
  const creates: ContainerCreateSpec[] = [];
  const removed: string[] = [];
  const exposedPorts = new Map<string, number | null>(
    Object.entries(options.exposedPorts ?? {}),
  );
  const running = new Map<string, { id: string; spec: ContainerCreateSpec }>();
  let nextId = 1;

  return {
    pulls,
    creates,
    removed,
    exposedPorts,
    running,
    async pullImage(image) {
      pulls.push(image);
    },
    async firstExposedPort(image) {
      return exposedPorts.has(image) ? exposedPorts.get(image)! : null;
    },
    async removeByName(name) {
      removed.push(name);
      running.delete(name);
    },
    async createAndStart(spec) {
      creates.push(spec);
      const id = `fake-${nextId++}`;
      running.set(spec.name, { id, spec });
      return { id };
    },
    async listPreviewContainers() {
      const out: CatalogContainer[] = [];
      for (const [name, { id }] of running) {
        const parsed = parsePreviewContainerName(name);
        if (!parsed) continue;
        out.push({
          containerId: id,
          containerName: name,
          slug: parsed.slug,
          prId: parsed.prId,
        });
      }
      return out;
    },
  };
}
