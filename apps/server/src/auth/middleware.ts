import { and, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import type { StateDb } from "../infrastructure/db/client.ts";
import { apiTokens } from "../infrastructure/db/schema.ts";
import { hashToken, parseBearer, type TokenScope } from "./tokens.ts";

export type AuthContext = {
  tokenHash: string;
  scope: TokenScope;
  canonicalRepoId: string | null;
};

export function lookupToken(db: StateDb, rawToken: string) {
  return db
    .select({
      tokenHash: apiTokens.tokenHash,
      scope: apiTokens.scope,
      canonicalRepoId: apiTokens.canonicalRepoId,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(rawToken)),
        isNull(apiTokens.revokedAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function unauthorized(set: { status?: number | string }) {
  set.status = 401;
  return { error: "unauthorized" };
}

function forbidden(set: { status?: number | string }) {
  set.status = 403;
  return { error: "forbidden" };
}

type AuthGuardContext = {
  auth: AuthContext | null;
  set: { status?: number | string };
};

export function requireAuth({ auth, set }: AuthGuardContext) {
  if (!auth) return unauthorized(set);
}

export function requireAdmin({ auth, set }: AuthGuardContext) {
  if (!auth) return unauthorized(set);
  if (auth.scope !== "admin") return forbidden(set);
}

export function requireDeployOrAdmin({ auth, set }: AuthGuardContext) {
  if (!auth) return unauthorized(set);
  if (auth.scope !== "admin" && auth.scope !== "deploy") return forbidden(set);
}

export function authPlugin(db: StateDb) {
  return new Elysia({ name: "auth" })
    .derive({ as: "scoped" }, async ({ request }) => {
      const raw = parseBearer(request.headers.get("authorization"));
      if (!raw) return { auth: null as AuthContext | null };
      const row = await lookupToken(db, raw);
      if (!row) return { auth: null as AuthContext | null };
      return {
        auth: {
          tokenHash: row.tokenHash,
          scope: row.scope as TokenScope,
          canonicalRepoId: row.canonicalRepoId,
        },
      };
    });
}

export { forbidden, unauthorized };
