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

/** Statuses that mean "no live preview DB intent" — deploy may (re)provision. */
const PROVISIONABLE = new Set(["removed", "error"]);

export const deployBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  slug: t.String({ minLength: 1 }),
  hostname: t.String({ minLength: 1 }),
});

/** Teardown does not need hostname; keep deploy's body separate. */
export const teardownBody = t.Object({
  canonical_repo_id: t.String({ minLength: 1 }),
  pr_id: t.Number(),
  slug: t.String({ minLength: 1 }),
});

export type DeployBody = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  hostname: string;
};

export type TeardownBody = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
};

export type LifecycleDeps = {
  db: StateDb;
  previewDb: PreviewDb;
};

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

type ParsedLifecycle = {
  repo: string;
  prId: number;
  slug: string;
};

function resolveRepo(
  auth: AuthContext,
  requested: string,
): Result<string> {
  if (auth.scope === "deploy" && auth.canonicalRepoId !== requested) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, value: requested };
}

function validateIds(slug: string, prId: number): Result<null> {
  const slugErr = validateSlug(slug);
  if (slugErr) return { ok: false, status: 422, error: slugErr };
  const prErr = validatePrId(prId);
  if (prErr) return { ok: false, status: 422, error: prErr };
  return { ok: true, value: null };
}

function parseLifecycleInput(
  auth: AuthContext,
  body: { canonical_repo_id: string; pr_id: number; slug: string },
): Result<ParsedLifecycle> {
  const repo = resolveRepo(auth, body.canonical_repo_id);
  if (!repo.ok) return repo;
  const ids = validateIds(body.slug, body.pr_id);
  if (!ids.ok) return ids;
  return {
    ok: true,
    value: { repo: repo.value, prId: body.pr_id, slug: body.slug },
  };
}

async function getPreviewRow(db: StateDb, repo: string, prId: number) {
  const [existing] = await db
    .select()
    .from(previews)
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    )
    .limit(1);
  return existing ?? null;
}

async function markPreviewError(
  db: StateDb,
  repo: string,
  prId: number,
): Promise<void> {
  await db
    .update(previews)
    .set({ status: "error", updatedAt: now })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

export function deploy(deps: LifecycleDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: DeployBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const parsed = parseLifecycleInput(auth, body);
    if (!parsed.ok) {
      set.status = parsed.status;
      return { error: parsed.error };
    }
    const { repo, prId, slug } = parsed.value;
    const dbName = previewDbName(slug, prId);
    const existing = await getPreviewRow(deps.db, repo, prId);

    if (existing && !PROVISIONABLE.has(existing.status)) {
      return {
        ok: true,
        canonical_repo_id: existing.canonicalRepoId,
        pr_id: existing.prId,
        slug: existing.slug,
        db_name: existing.dbName,
        hostname: existing.hostname,
        status: existing.status,
      };
    }

    // Record intent in SQLite before DDL so partial failure is visible.
    if (existing) {
      await deps.db
        .update(previews)
        .set({
          slug,
          dbName,
          hostname: body.hostname,
          status: "provisioning",
          appImage: null,
          containerId: null,
          seededAt: null,
          updatedAt: now,
        })
        .where(
          and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
        );
    } else {
      await deps.db.insert(previews).values({
        canonicalRepoId: repo,
        prId,
        slug,
        dbName,
        hostname: body.hostname,
        status: "provisioning",
      });
    }

    try {
      await deps.previewDb.createDatabase(dbName);
    } catch {
      await markPreviewError(deps.db, repo, prId);
      set.status = 500;
      return { error: "preview_db_create_failed" };
    }

    return {
      ok: true,
      canonical_repo_id: repo,
      pr_id: prId,
      slug,
      db_name: dbName,
      hostname: body.hostname,
      status: "provisioning",
    };
  };
}

export function teardown(deps: LifecycleDeps) {
  return async ({
    body,
    auth,
    set,
  }: {
    body: TeardownBody;
    auth: AuthContext | null;
    set: { status?: number | string };
  }) => {
    if (!auth) {
      set.status = 401;
      return { error: "unauthorized" };
    }
    const parsed = parseLifecycleInput(auth, body);
    if (!parsed.ok) {
      set.status = parsed.status;
      return { error: parsed.error };
    }
    const { repo, prId } = parsed.value;
    const existing = await getPreviewRow(deps.db, repo, prId);

    if (!existing || existing.status === "removed") {
      return { ok: true, status: "removed" };
    }

    // Mark removing before DDL so stuck teardowns are detectable / retryable.
    await deps.db
      .update(previews)
      .set({ status: "removing", updatedAt: now })
      .where(
        and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
      );

    try {
      await deps.previewDb.dropDatabase(existing.dbName);
    } catch {
      await markPreviewError(deps.db, repo, prId);
      set.status = 500;
      return { error: "preview_db_drop_failed" };
    }

    await deps.db
      .update(previews)
      .set({ status: "removed", updatedAt: now })
      .where(
        and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
      );

    return { ok: true, status: "removed" };
  };
}
