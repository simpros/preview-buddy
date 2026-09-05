import {
  parsePreviewContainerName,
  previewContainerName,
} from "../preview/naming.ts";
import type {
  CatalogContainer,
  ContainerCreateSpec,
  DockerClient,
} from "./port.ts";

export type DockerEngineOptions = {
  socketPath?: string;
  /** Registry auth for pulls; omit or empty user = anonymous. */
  registryAuth?: { username: string; password: string };
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit & { unix?: string },
  ) => Promise<Response>;
};

type DockerContainerRow = {
  Id: string;
  Names?: string[];
};

type ImageInspect = {
  Config?: {
    ExposedPorts?: Record<string, unknown>;
  };
};

function encodeRegistryAuth(
  auth: { username: string; password: string } | undefined,
): string | undefined {
  if (!auth || auth.username === "") return undefined;
  return Buffer.from(
    JSON.stringify({
      username: auth.username,
      password: auth.password,
    }),
  ).toString("base64");
}

function splitImageRef(image: string): { fromImage: string; tag: string } {
  const at = image.lastIndexOf("@");
  if (at !== -1) {
    return { fromImage: image.slice(0, at), tag: image.slice(at + 1) };
  }
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return {
      fromImage: image.slice(0, lastColon),
      tag: image.slice(lastColon + 1),
    };
  }
  return { fromImage: image, tag: "latest" };
}

function firstExposedPortFromInspect(inspect: ImageInspect): number | null {
  const exposed = inspect.Config?.ExposedPorts;
  if (!exposed) return null;
  for (const key of Object.keys(exposed)) {
    const match = /^(\d+)\//.exec(key);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Docker Engine API client over the unix socket. */
export function createDockerEngineClient(
  options: DockerEngineOptions = {},
): DockerClient {
  const socketPath = options.socketPath ?? "/var/run/docker.sock";
  const fetchImpl = options.fetch ?? fetch;
  const registryAuthHeader = encodeRegistryAuth(options.registryAuth);

  async function engine(
    path: string,
    init: RequestInit & { unix?: string } = {},
  ): Promise<Response> {
    return fetchImpl(`http://localhost${path}`, {
      ...init,
      unix: socketPath,
    });
  }

  return {
    async pullImage(image) {
      const { fromImage, tag } = splitImageRef(image);
      const qs = new URLSearchParams({ fromImage, tag });
      const headers: Record<string, string> = {};
      if (registryAuthHeader) {
        headers["X-Registry-Auth"] = registryAuthHeader;
      }
      const res = await engine(`/images/create?${qs}`, {
        method: "POST",
        headers,
      });
      // Drain the progress stream body so the pull completes.
      await res.text();
      if (!res.ok) {
        throw new Error(`Docker pull ${image} failed: ${res.status}`);
      }
    },

    async firstExposedPort(image) {
      const res = await engine(`/images/${encodeURIComponent(image)}/json`, {
        method: "GET",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Docker inspect image ${image} failed: ${res.status} ${body}`,
        );
      }
      return firstExposedPortFromInspect((await res.json()) as ImageInspect);
    },

    async removeByName(name) {
      const res = await engine(
        `/containers/${encodeURIComponent(name)}?force=true`,
        { method: "DELETE" },
      );
      if (res.status !== 204 && res.status !== 404) {
        const body = await res.text();
        throw new Error(`Docker remove ${name} failed: ${res.status} ${body}`);
      }
    },

    async createAndStart(spec: ContainerCreateSpec) {
      if (spec.networkNames.length === 0) {
        throw new Error("createAndStart requires at least one network");
      }
      const [primary, ...rest] = spec.networkNames;
      const endpoints: Record<string, Record<string, never>> = {};
      for (const n of spec.networkNames) {
        endpoints[n!] = {};
      }
      const createRes = await engine(
        `/containers/create?name=${encodeURIComponent(spec.name)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            Image: spec.image,
            Env: spec.env,
            Labels: spec.labels,
            HostConfig: {
              NetworkMode: primary,
            },
            NetworkingConfig: {
              EndpointsConfig: endpoints,
            },
          }),
        },
      );
      if (!createRes.ok) {
        const body = await createRes.text();
        throw new Error(
          `Docker create ${spec.name} failed: ${createRes.status} ${body}`,
        );
      }
      const { Id: id } = (await createRes.json()) as { Id: string };

      for (const network of rest) {
        const connectRes = await engine(
          `/networks/${encodeURIComponent(network!)}/connect`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ Container: id }),
          },
        );
        if (!connectRes.ok) {
          const body = await connectRes.text();
          throw new Error(
            `Docker connect ${spec.name} to ${network} failed: ${connectRes.status} ${body}`,
          );
        }
      }

      const startRes = await engine(
        `/containers/${encodeURIComponent(id)}/start`,
        { method: "POST" },
      );
      if (!startRes.ok && startRes.status !== 304) {
        const body = await startRes.text();
        throw new Error(
          `Docker start ${spec.name} failed: ${startRes.status} ${body}`,
        );
      }
      return { id };
    },

    async listPreviewContainers() {
      const filters = encodeURIComponent(JSON.stringify({ name: ["pb-"] }));
      const res = await engine(`/containers/json?all=true&filters=${filters}`, {
        method: "GET",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Docker list containers failed: ${res.status} ${body}`);
      }
      const rows = (await res.json()) as DockerContainerRow[];
      const out: CatalogContainer[] = [];
      for (const row of rows) {
        for (const rawName of row.Names ?? []) {
          const name = rawName.replace(/^\//, "");
          const parsed = parsePreviewContainerName(name);
          if (!parsed) continue;
          out.push({
            containerId: row.Id,
            containerName: name,
            slug: parsed.slug,
            prId: parsed.prId,
          });
          break;
        }
      }
      return out;
    },
  };
}

/** Adapt DockerClient to the sweep ContainerPorts shape. */
export function dockerAsContainerPorts(docker: DockerClient): {
  listPreviewContainers: DockerClient["listPreviewContainers"];
  remove: (opts: { slug: string; prId: number }) => Promise<void>;
} {
  return {
    listPreviewContainers: () => docker.listPreviewContainers(),
    remove: ({ slug, prId }) =>
      docker.removeByName(previewContainerName(slug, prId)),
  };
}

export { firstExposedPortFromInspect, splitImageRef };
