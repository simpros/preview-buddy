import { t } from "elysia";
import type { AuthContext } from "../auth/middleware.ts";
import { generatePreviewAuthSecret, generateBasicPassword } from "../preview/auth.ts";
import {
  authDenyLog,
  mintPreviewLinkToken,
  parseLinkExpiry,
  safeEqualSecret,
  shareableLink,
  verifyPreviewLinkToken,
  PREVIEW_AUTH_COOKIE,
  PREVIEW_AUTH_PATH,
} from "../preview/auth.ts";
import {
  getPreviewRow,
  type LifecycleDeps,
} from "../preview/lifecycle.ts";
import { updatePreviewRow } from "../preview/row.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  mapResult,
  requirePreviewTarget,
  requireReadablePreviewRow,
} from "./result-map.ts";

export const accessQuery = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.String({ minLength: 1 }),
  expires: t.Optional(t.String({ minLength: 1 })),
});

export const revokeBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
});

export type AccessDeps = Pick<LifecycleDeps, "db"> & {
  previewAuth?: { secret: string; address: string };
};

function firstForwardedHost(value: string): string {
  return value.split(",")[0]?.trim() ?? "";
}

/** Traefik calls this address; never the global forwardAuth seam. */
export function verifyPreviewAccess(deps: AccessDeps) {
  return async ({
    headers,
    set,
  }: {
    headers: Record<string, string | undefined>;
    set: { status?: number | string };
  }) => {
    const host = firstForwardedHost(
      headers["x-forwarded-host"] ?? headers.host ?? "",
    ).split(":")[0] ?? "";
    const uri = headers["x-forwarded-uri"] ?? "/";
    const deny = (
      reason: string,
      status: number,
      identity?: { repo: string; prId: number },
    ) => {
      console.warn(
        authDenyLog({
          host,
          repo: identity?.repo ?? "",
          prId: identity?.prId ?? 0,
          reason,
        }),
      );
      set.status = status;
      return { error: "preview_auth_required" as const, reason };
    };
    if (!deps.previewAuth) {
      return deny("preview_auth_not_configured", 401);
    }
    if (!host) return deny("unknown_preview", 401);
    const [row] = await deps.db
      .select()
      .from(previews)
      .where(eq(previews.hostname, host))
      .limit(1);
    if (!row || row.status === "removed" || row.status === "removing") {
      return deny("unknown_preview", 401);
    }
    const identity = { repo: row.canonicalRepoId, prId: row.prId };
    const mode = row.authMode ?? "none";
    if (mode !== "link" && mode !== "basic") {
      return deny("preview_not_gated", 401, identity);
    }
    const path = uri.split("?")[0] ?? "/";
    if (path === PREVIEW_AUTH_PATH) {
      const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
      const token = new URLSearchParams(query).get("t") ?? "";
      if (!token) return deny("missing", 401, identity);
      if (mode !== "link" || !row.authSecret) {
        return deny("preview_not_gated", 401, identity);
      }
      const checked = verifyPreviewLinkToken({
        gatewaySecret: deps.previewAuth.secret,
        token,
        repo: row.canonicalRepoId,
        prId: row.prId,
        version: row.authSecret,
      });
      if (!checked.ok) return deny(checked.reason, 401, identity);
      const cookie = `${PREVIEW_AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
      return new Response(JSON.stringify({ ok: true }), {
        status: 302,
        headers: {
          "content-type": "application/json",
          location: "/",
          "set-cookie": cookie,
        },
      });
    }
    const cookieHeader = headers.cookie ?? "";
    const cookie = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${PREVIEW_AUTH_COOKIE}=`))
      ?.slice(PREVIEW_AUTH_COOKIE.length + 1);
    if (cookie) {
      if (mode !== "link" || !row.authSecret) {
        return deny("preview_not_gated", 401, identity);
      }
      const checked = verifyPreviewLinkToken({
        gatewaySecret: deps.previewAuth.secret,
        token: cookie,
        repo: row.canonicalRepoId,
        prId: row.prId,
        version: row.authSecret,
      });
      if (!checked.ok) return deny(checked.reason, 401, identity);
      set.status = 200;
      return { ok: true as const };
    }
    if (mode === "basic") {
      const authorization = headers.authorization ?? "";
      const match = /^Basic (.+)$/.exec(authorization.trim());
      if (match) {
        const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        const user = sep >= 0 ? decoded.slice(0, sep) : "";
        const password = sep >= 0 ? decoded.slice(sep + 1) : "";
        if (
          row.authBasicUser &&
          row.authBasicPassword &&
          safeEqualSecret(user, row.authBasicUser) &&
          safeEqualSecret(password, row.authBasicPassword)
        ) {
          set.status = 200;
          return { ok: true as const };
        }
        return deny("basic_rejected", 401, identity);
      }
    }
    set.status = 401;
    console.warn(
      authDenyLog({
        host,
        repo: row.canonicalRepoId,
        prId: row.prId,
        reason: "missing",
      }),
    );
    return new Response(
      JSON.stringify({ error: "preview_auth_required", reason: "missing" }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Basic realm="preview"',
        },
      },
    );
  };
}

export function getPreviewAccess(deps: AccessDeps) {
  return async ({
    query,
    auth,
    set,
  }: {
    query: { canonical_repo_id: string; pr_id: string; expires?: string };
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    const result = await requireReadablePreviewRow(
      deps,
      auth,
      query.canonical_repo_id,
      query.pr_id,
    );
    if (!result.ok) return mapResult(result, set);
    const row = result.value;
    const mode = row.authMode ?? "none";
    if (mode === "basic") {
      if (!row.authBasicUser || !row.authBasicPassword) {
        set.status = 500;
        return { error: "preview_auth_missing_credential" };
      }
      return {
        ok: true as const,
        auth: "basic" as const,
        username: row.authBasicUser,
        password: row.authBasicPassword,
        hostname: row.hostname,
      };
    }
    if (mode === "link") {
      if (!deps.previewAuth || !row.authSecret) {
        set.status = 500;
        return { error: "preview_auth_not_configured" };
      }
      const expiry = parseLinkExpiry(query.expires);
      if (!expiry.ok) {
        set.status = 422;
        return { error: "invalid_expires", detail: expiry.error };
      }
      const token = mintPreviewLinkToken({
        gatewaySecret: deps.previewAuth.secret,
        repo: row.canonicalRepoId,
        prId: row.prId,
        version: row.authSecret,
        expiresAtMs: expiry.expiresAtMs,
      });
      return {
        ok: true as const,
        auth: "link" as const,
        url: shareableLink(row.hostname, token),
        expires_at: new Date(expiry.expiresAtMs).toISOString(),
        hostname: row.hostname,
      };
    }
    return {
      ok: true as const,
      auth: "none" as const,
      hostname: row.hostname,
      preview_url: `https://${row.hostname}`,
    };
  };
}

export function revokePreviewAccess(deps: AccessDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: { canonical_repo_id: string; pr_id: number };
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    const target = requirePreviewTarget(
      auth,
      body.canonical_repo_id,
      body.pr_id,
    );
    if (!target.ok) return mapResult(target, set);
    const row = await getPreviewRow(deps.db, target.value.repo, target.value.prId);
    if (!row || row.status === "removed") {
      set.status = 404;
      return { error: "preview_not_found" };
    }
    const mode = row.authMode ?? "none";
    if (mode === "link") {
      await updatePreviewRow(
        deps.db,
        row,
        { authSecret: generatePreviewAuthSecret() },
        "preview_row_missing_on_revoke",
      );
      return { ok: true as const, auth: "link" as const, revoked: true as const };
    }
    if (mode === "basic") {
      await updatePreviewRow(
        deps.db,
        row,
        { authBasicPassword: generateBasicPassword() },
        "preview_row_missing_on_revoke",
      );
      return {
        ok: true as const,
        auth: "basic" as const,
        revoked: true as const,
        relabel_required: true as const,
      };
    }
    set.status = 422;
    return { error: "access_not_gated" };
  };
}
