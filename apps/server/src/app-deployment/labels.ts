/** Traefik Docker-provider labels for a preview app container. */
export function traefikLabels(input: {
  /** Stable router/service name (typically the container name). */
  routerName: string;
  hostname: string;
  port: number;
}): Record<string, string> {
  const { routerName, hostname, port } = input;
  return {
    "traefik.enable": "true",
    [`traefik.http.routers.${routerName}.rule`]: `Host(\`${hostname}\`)`,
    [`traefik.http.services.${routerName}.loadbalancer.server.port`]: String(
      port,
    ),
  };
}
