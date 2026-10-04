import type { PreviewLabels } from "@sprout/preview-env";

/** Opt-in wildcard mode: routers declare tls.domains for their suffix, which needs a DNS-01 cert resolver. */
export type TraefikTls =
  | {
      entrypoints: string;
      certResolver?: string;
      wildcard?: false;
    }
  | {
      entrypoints: string;
      certResolver: string;
      wildcard: true;
    };

export type TraefikForwardAuth = {
  middleware: string;
  address: string;
};

export type TraefikBasicAuth = {
  middleware: string;
  /** htpasswd entry `user:hash` (hash never logged). */
  users: string;
};

export type TraefikPreviewForwardAuth = {
  middleware: string;
  address: string;
};

/**
 * Suffix a wildcard covers: the hostname with its first label removed.
 * A wildcard covers exactly one label, so `pr-42.a.previews.example.com`
 * needs `*.a.previews.example.com`, not `*.previews.example.com`.
 * The suffix needs at least two labels to be a usable domain set.
 */
export function wildcardSuffix(hostname: string): string {
  const labels = hostname.split(".");
  if (labels.length < 3) {
    throw new Error(
      `Cannot derive wildcard TLS suffix from hostname ${JSON.stringify(hostname)}: need at least three labels (got ${labels.length})`,
    );
  }
  return labels.slice(1).join(".");
}

/** Domain set matching the wildcard-bootstrap shape: wildcard main + apex SAN. */
export function wildcardDomains(hostname: string): { main: string; sans: string } {
  const suffix = wildcardSuffix(hostname);
  return { main: `*.${suffix}`, sans: suffix };
}

/** Static key names for the wildcard domain set: values vary per suffix, names do not. */
function tlsDomainKeys(routerName: string): string[] {
  return [
    `traefik.http.routers.${routerName}.tls.domains[0].main`,
    `traefik.http.routers.${routerName}.tls.domains[0].sans`,
  ];
}

const FORWARDAUTH_RESPONSE_HEADERS =
  "Remote-User,Remote-Email,Remote-Groups";

export function traefikRouterRule(input: {
  hostname: string;
  pathPrefix?: string;
}): string {
  const host = `Host(\`${input.hostname}\`)`;
  if (!input.pathPrefix) return host;
  return `${host} && PathPrefix(\`${input.pathPrefix}\`)`;
}

export function traefikLabels(input: {
  routerName: string;
  hostname: string;
  port: number;
  pathPrefix?: string;
  tls?: TraefikTls;
  forwardAuth?: TraefikForwardAuth;
  basicAuth?: TraefikBasicAuth;
  previewForwardAuth?: TraefikPreviewForwardAuth;
}): Record<string, string> {
  const {
    routerName,
    hostname,
    port,
    pathPrefix,
    tls,
    forwardAuth,
    basicAuth,
    previewForwardAuth,
  } = input;
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${routerName}.rule`]: traefikRouterRule({
      hostname,
      pathPrefix,
    }),
    [`traefik.http.services.${routerName}.loadbalancer.server.port`]: String(
      port,
    ),
  };
  if (tls) {
    labels[`traefik.http.routers.${routerName}.tls`] = "true";
    labels[`traefik.http.routers.${routerName}.entrypoints`] = tls.entrypoints;
    if (tls.certResolver !== undefined) {
      labels[`traefik.http.routers.${routerName}.tls.certresolver`] =
        tls.certResolver;
    }
    if (tls.wildcard === true) {
      const domains = wildcardDomains(hostname);
      const [mainKey, sansKey] = tlsDomainKeys(routerName);
      labels[mainKey] = domains.main;
      labels[sansKey] = domains.sans;
    }
  }
  if (forwardAuth || basicAuth || previewForwardAuth) {
    const chain = [
      forwardAuth?.middleware,
      basicAuth?.middleware,
      previewForwardAuth?.middleware,
    ].filter((name): name is string => name !== undefined);
    labels[`traefik.http.routers.${routerName}.middlewares`] =
      chain.join(",");
  }
  if (forwardAuth) {
    const { middleware, address } = forwardAuth;
    labels[`traefik.http.middlewares.${middleware}.forwardauth.address`] =
      address;
    labels[
      `traefik.http.middlewares.${middleware}.forwardauth.trustForwardHeader`
    ] = "true";
    labels[
      `traefik.http.middlewares.${middleware}.forwardauth.authResponseHeaders`
    ] = FORWARDAUTH_RESPONSE_HEADERS;
  }
  if (basicAuth) {
    const { middleware, users } = basicAuth;
    labels[`traefik.http.middlewares.${middleware}.basicauth.users`] = users;
    labels[`traefik.http.middlewares.${middleware}.basicauth.removeheader`] =
      "true";
  }
  if (previewForwardAuth) {
    const { middleware, address } = previewForwardAuth;
    labels[`traefik.http.middlewares.${middleware}.forwardauth.address`] =
      address;
    labels[
      `traefik.http.middlewares.${middleware}.forwardauth.trustForwardHeader`
    ] = "true";
  }
  return labels;
}

/**
 * Reserved key shapes without a port/hostname: key names never depend on
 * the rule value or the loadbalancer port, so dummy values suffice. The
 * wildcard domain keys are appended structurally: their names never depend
 * on a suffix value, so enumeration must not validate a placeholder
 * hostname to discover them.
 */
export function traefikLabelKeys(input: {
  routerName: string;
  tls?: TraefikTls;
  forwardAuth?: TraefikForwardAuth;
  basicAuth?: TraefikBasicAuth;
  previewForwardAuth?: TraefikPreviewForwardAuth;
}): string[] {
  const keys = Object.keys(
    traefikLabels({
      routerName: input.routerName,
      hostname: "placeholder.example.com",
      port: 1,
      tls:
        input.tls?.wildcard === true
          ? {
              entrypoints: input.tls.entrypoints,
              certResolver: input.tls.certResolver,
            }
          : input.tls,
      forwardAuth: input.forwardAuth,
      basicAuth: input.basicAuth,
      previewForwardAuth: input.previewForwardAuth,
    }),
  );
  if (input.tls?.wildcard === true) {
    keys.push(...tlsDomainKeys(input.routerName));
  }
  return keys;
}

export type ServiceLabelSource = {
  labels: PreviewLabels | undefined;
  index: number;
};

/**
 * First collision wins: preview-level and per-service labels share one
 * effective map per container, and a service value shadows the preview
 * level for the same key. Returns the manifest path to quote, or null.
 */
export function reservedKeyCollision(
  gatewayKeys: readonly string[],
  preview: PreviewLabels | undefined,
  service?: ServiceLabelSource,
): { manifestPath: string } | null {
  const reserved = new Set(gatewayKeys);
  const effective = { ...preview, ...service?.labels };
  for (const key of Object.keys(effective)) {
    if (reserved.has(key)) {
      const fromService =
        service?.labels !== undefined && key in service.labels;
      return {
        manifestPath: fromService
          ? `preview.services[${service.index}].labels.${key}`
          : `preview.labels.${key}`,
      };
    }
  }
  return null;
}

/**
 * Pure merge of adopter labels over the gateway set. Collision rejection
 * lives in the deploy gate (resolveLabelCollisions), which runs before any
 * container exists; by the time inputs reach materialization the check has
 * already passed, so this stays total and never throws.
 * Per-service values win over preview-level ones for the same key.
 */
export function mergePreviewLabels(
  gateway: PreviewLabels,
  preview: PreviewLabels | undefined,
  service?: ServiceLabelSource,
): PreviewLabels {
  return { ...gateway, ...preview, ...service?.labels };
}
