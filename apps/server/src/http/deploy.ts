import { t } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "../auth/middleware.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  previewDbName,
  validatePrId,
  validateSlug,
} from "../preview-db/names.ts";
import type { PreviewDb } from "../preview-db/port.ts";

const now = sql`(datetime('now'))`;

export const lifecycleBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  slug: t.String({ minLength: 1 }),
  hostname: t.String({ minLength: 1 }),
});

export type DeployBody = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  hostname: string;
};

export type LifecycleDeps = {
  db: StateDb;
  previewDb: PreviewDb;
};

type HandlerCtx = {
  body: DeployBody;
  auth: AuthContext | null;
  set: { status?: number | string };
};

function resolveRepo(
  auth: AuthContext,
  requested: string,
  set: { status?: number | string },
): string | { error: string } {
  if (auth.scope === "deploy" && auth.canonicalRepoId !== requested) {
    set.status = 403;
    return { error: "forbidden" };
  }
  return requested;
}

function validateIds(
  slug: string,
  prId: number,
  set: { status?: number | string },
): { error: string } | null {
  const slugErr = validateSlug(slug);
  if (slugErr) {
    set.status = 422;
    return { error: slugErr };
  }
  const prErr = validatePrId(prId);
  if (prErr) {
    set.status = 422;
    return { error: prErr };
  }
  return null;
}

export function deploy(deps: LifecycleDeps) {
  return async ({ body, auth, set }: HandlerCtx) => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const repo = resolveRepo(auth, body.canonical_repo_id, set);
    if (typeof repo !== "string") return repo;

    const invalid = validateIds(body.slug, body.pr_id, set);
    if (invalid) return invalid;

    const dbName = previewDbName(body.slug, body.pr_id);
    const [existing] = await deps.db
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.canonicalRepoId, repo),
          eq(previews.prId, body.pr_id),
        ),
      )
      .limit(1);

    if (!existing || existing.status === "removed") {
      await deps.previewDb.createDatabase(dbName);
      if (existing) {
        await deps.db
          .update(previews)
          .set({
            slug: body.slug,
            dbName,
            hostname: body.hostname,
            status: "provisioning",
            appImage: null,
            containerId: null,
            seededAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(previews.canonicalRepoId, repo),
              eq(previews.prId, body.pr_id),
            ),
          );
      } else {
        await deps.db.insert(previews).values({
          canonicalRepoId: repo,
          prId: body.pr_id,
          slug: body.slug,
          dbName,
          hostname: body.hostname,
          status: "provisioning",
        });
      }
      return {
        ok: true,
        canonical_repo_id: repo,
        pr_id: body.pr_id,
        slug: body.slug,
        db_name: dbName,
        hostname: body.hostname,
        status: "provisioning",
      };
    }

    return {
      ok: true,
      canonical_repo_id: existing.canonicalRepoId,
      pr_id: existing.prId,
      slug: existing.slug,
      db_name: existing.dbName,
      hostname: existing.hostname,
      status: existing.status,
    };
  };
}

export function teardown(deps: LifecycleDeps) {
  return async ({ body, auth, set }: HandlerCtx) => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const repo = resolveRepo(auth, body.canonical_repo_id, set);
    if (typeof repo !== "string") return repo;

    const invalid = validateIds(body.slug, body.pr_id, set);
    if (invalid) return invalid;

    const [existing] = await deps.db
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.canonicalRepoId, repo),
          eq(previews.prId, body.pr_id),
        ),
      )
      .limit(1);

    if (!existing || existing.status === "removed") {
      return { ok: true, status: "removed" };
    }

    await deps.previewDb.dropDatabase(existing.dbName);
    await deps.db
      .update(previews)
      .set({
        status: "removed",
        updatedAt: now,
      })
      .where(
        and(
          eq(previews.canonicalRepoId, repo),
          eq(previews.prId, body.pr_id),
        ),
      );

    return { ok: true, status: "removed" };
  };
}
