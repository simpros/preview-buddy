export type CatalogContainer = {
  containerId: string;
  containerName: string;
  slug: string;
  prId: number;
};

/** Spec for creating a preview (or other) container via the Docker engine. */
export type ContainerCreateSpec = {
  name: string;
  image: string;
  /** `KEY=VALUE` entries — app containers get only the five PG* vars. */
  env: string[];
  labels: Record<string, string>;
  /** Attach in order; first is the primary network at create time. */
  networkNames: string[];
};

/**
 * Docker engine seam for app-deployment and sweep.
 * Tests use a fake; production uses the unix-socket engine client.
 */
export type DockerClient = {
  pullImage(image: string): Promise<void>;
  /** First EXPOSE port from the image config, or null if none. */
  firstExposedPort(image: string): Promise<number | null>;
  /** Force-remove by container name; 404 is success. */
  removeByName(name: string): Promise<void>;
  createAndStart(spec: ContainerCreateSpec): Promise<{ id: string }>;
  listPreviewContainers(): Promise<CatalogContainer[]>;
};
