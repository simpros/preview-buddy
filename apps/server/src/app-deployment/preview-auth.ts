import type { PreviewAuthConfig } from "../config.ts";
import {
  hashBasicPassword,
  previewAuthMiddleware,
} from "../preview/auth.ts";
import type { PreviewAccessLabels } from "./workload-labels.ts";

export type StoredPreviewAuth = {
  authMode: string | null;
  authSecret: string | null;
  authBasicUser: string | null;
  authBasicPassword: string | null;
};

/**
 * Per-preview gate for the app router. Services never receive it
 * (companions keep their own protection, no double gate). Resolves to
 * `{ mode: "none" }` when the preview is open, so emission stays
 * byte-identical to the unconfigured gateway.
 */
export async function resolvePreviewAccessLabels(input: {
  slug: string;
  prId: number;
  stored: StoredPreviewAuth;
  previewAuth?: PreviewAuthConfig;
}): Promise<PreviewAccessLabels> {
  const mode = input.stored.authMode ?? "none";
  const middleware = previewAuthMiddleware(input.slug, input.prId);
  if (mode === "basic") {
    const user = input.stored.authBasicUser;
    const password = input.stored.authBasicPassword;
    if (!user || !password) {
      throw new Error(
        `preview basic auth requested for ${input.slug} pr=${input.prId} without a stored credential`,
      );
    }
    return {
      mode: "basic",
      basicAuth: {
        middleware,
        users: `${user}:${await hashBasicPassword(password)}`,
      },
    };
  }
  if (mode === "link") {
    if (!input.previewAuth) {
      throw new Error(
        `preview link auth requested for ${input.slug} pr=${input.prId} without gateway preview auth configured`,
      );
    }
    return {
      mode: "link",
      previewForwardAuth: {
        middleware,
        address: input.previewAuth.address,
      },
    };
  }
  return { mode: "none" };
}

/** Key-only access for fail-fast collision validation (hash unknown yet). */
export function previewAccessForKeys(input: {
  slug: string;
  prId: number;
  mode: "none" | "basic" | "link";
  address?: string;
}): PreviewAccessLabels {
  const middleware = previewAuthMiddleware(input.slug, input.prId);
  if (input.mode === "basic") {
    return { mode: "basic", basicAuth: { middleware, users: "sprout:dummy" } };
  }
  if (input.mode === "link") {
    return {
      mode: "link",
      previewForwardAuth: { middleware, address: input.address ?? "" },
    };
  }
  return { mode: "none" };
}
