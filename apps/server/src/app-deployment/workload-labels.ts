import type { PreviewLabels, PreviewServiceSpec } from "@sprout/preview-env";
import {
  traefikLabelKeys,
  traefikLabels,
  type TraefikBasicAuth,
  type TraefikForwardAuth,
  type TraefikPreviewForwardAuth,
  type TraefikTls,
} from "./labels.ts";

export type TraefikPolicy = {
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
};

/** Per-preview gate attached to the app router only; services are never double-gated. */
export type PreviewAccessLabels =
  | { mode: "none" }
  | { mode: "basic"; basicAuth: TraefikBasicAuth }
  | { mode: "link"; previewForwardAuth: TraefikPreviewForwardAuth };

export type PreviewWorkloadRouting =
  | {
      kind: "routed";
      hostname: string;
      pathPrefix?: string;
      tls?: TraefikTls;
      forwardAuth?: TraefikForwardAuth;
      basicAuth?: TraefikBasicAuth;
      previewForwardAuth?: TraefikPreviewForwardAuth;
    }
  | { kind: "internal" };

/**
 * Single seam for routing/label derivation: the app container is always
 * routed, a service is routed when it sets a hostname or path. Both the
 * materialization path and the deploy gate (resolveLabelCollisions) build
 * their reserved sets from appRouting/serviceRouting plus gatewayLabelKeys,
 * so validation cannot drift from what the containers receive.
 */
export function appRouting(
  hostname: string,
  policy: TraefikPolicy,
  access?: PreviewAccessLabels,
): PreviewWorkloadRouting {
  return {
    kind: "routed",
    hostname,
    tls: policy.traefikTls,
    forwardAuth: policy.traefikForwardAuth,
    ...(access?.mode === "basic" ? { basicAuth: access.basicAuth } : {}),
    ...(access?.mode === "link"
      ? { previewForwardAuth: access.previewForwardAuth }
      : {}),
  };
}

export function serviceRouting(
  service: Pick<PreviewServiceSpec, "hostname" | "path">,
  appHostname: string,
  policy: TraefikPolicy,
): PreviewWorkloadRouting {
  if (service.hostname == null && service.path == null) {
    return { kind: "internal" };
  }
  return {
    kind: "routed",
    hostname: service.hostname ?? appHostname,
    ...(service.path !== undefined ? { pathPrefix: service.path } : {}),
    tls: policy.traefikTls,
    forwardAuth: policy.traefikForwardAuth,
  };
}

export function gatewayLabels(
  name: string,
  routing: PreviewWorkloadRouting,
  port: number,
): PreviewLabels {
  if (routing.kind !== "routed") return {};
  return traefikLabels({
    routerName: name,
    hostname: routing.hostname,
    port,
    pathPrefix: routing.pathPrefix,
    tls: routing.tls,
    forwardAuth: routing.forwardAuth,
    basicAuth: routing.basicAuth,
    previewForwardAuth: routing.previewForwardAuth,
  });
}

/**
 * Key-only derivation for fail-fast validation: key names never depend on
 * the hostname, path, or port values, so callers pass no dummy sentinels.
 */
export function gatewayLabelKeys(
  name: string,
  routing: PreviewWorkloadRouting,
): string[] {
  if (routing.kind !== "routed") return [];
  return traefikLabelKeys({
    routerName: name,
    tls: routing.tls,
    forwardAuth: routing.forwardAuth,
    basicAuth: routing.basicAuth,
    previewForwardAuth: routing.previewForwardAuth,
  });
}
