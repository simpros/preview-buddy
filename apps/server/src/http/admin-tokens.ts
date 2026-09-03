import { eq, sql } from "drizzle-orm";
import { t } from "elysia";
import { generateToken, hashToken } from "../auth/tokens.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { apiTokens, repos } from "../infrastructure/db/schema.ts";

function tokenResponse(row: {
  tokenHash: string;
  scope: string;
  canonicalRepoId: string | null;
  createdAt: string;
  revokedAt: string | null;
}) {
  return {
    id: row.tokenHash,
    scope: row.scope,
    canonical_repo_id: row.canonicalRepoId,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

export const createDeployTokenBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  slug: t.String({ minLength: 1 }),
});

export function listTokens(db: StateDb) {
  return async () => {
    const rows = await db.select().from(apiTokens);
    return { tokens: rows.map(tokenResponse) };
  };
}

export function createDeployToken(db: StateDb) {
  return async ({
    body,
    set,
  }: {
    body: { canonical_repo_id: string; slug: string };
    set: { status?: number | string };
  }) => {
    const raw = generateToken();
    const tokenHash = hashToken(raw);
    await db
      .insert(repos)
      .values({
        canonicalId: body.canonical_repo_id,
        slug: body.slug,
      })
      .onConflictDoNothing();

    await db.insert(apiTokens).values({
      tokenHash,
      scope: "deploy",
      canonicalRepoId: body.canonical_repo_id,
    });

    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .limit(1);

    set.status = 201;
    return { ...tokenResponse(row!), token: raw };
  };
}

export function revokeToken(db: StateDb) {
  return async ({
    params,
    set,
  }: {
    params: { id: string };
    set: { status?: number | string };
  }) => {
    const result = await db
      .update(apiTokens)
      .set({ revokedAt: sql`(datetime('now'))` })
      .where(eq(apiTokens.tokenHash, params.id))
      .returning({ tokenHash: apiTokens.tokenHash });

    if (result.length === 0) {
      set.status = 404;
      return { error: "not found" };
    }
    return { ok: true };
  };
}
