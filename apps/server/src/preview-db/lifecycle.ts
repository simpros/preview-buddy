import { and, eq, ne } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewDbName } from "./names.ts";
import type { PreviewDb } from "./port.ts";

function utcIsoNow(): string {
  return new Date().toISOString();
}

/**
 * Preview lifecycle statuses known to this slice.
 * `ready` = DB exists (awaiting app slice). Keep `error` (not `failed`).
 */
export type PreviewStatus =
  | "provisioning"
  | "ready"
  | "removing"
  | "removed"
  | "error";

export type LifecycleDeps = {
  db: StateDb;
  previewDb: PreviewDb;
};

export type ProvisionInput = {
  repo: string;
  prId: number;
  slug: string;
  hostname: string;
};

export type TeardownInput = {
  repo: string;
  prId: number;
};

/**
 * Sweep control-plane remove: revalidate generation under lock, then same
 * machine as teardown. Eligibility (TTL / PR-closed) is decided at plan time;
 * under the lock we only verify identity + generation have not moved.
 */
export type RemovePreviewInput = {
  repo: string;
  prId: number;
  expectedDbName: string;
  /** Abort if provision refreshed createdAt since the sweep plan. */
  expectedCreatedAt: string;
};

export type PreviewSnapshot = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  db_name: string;
  hostname: string;
  status: PreviewStatus;
};

export type TeardownSnapshot = {
  ok: true;
  status: "removed";
};

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export type PreviewRow = typeof previews.$inferSelect;

/**
 * Serialize control-plane mutations per (repo, prId).
 * ADR 0001: one gateway process — in-process queue is the concurrency design.
 * ponytail: global Map; upgrade to shared lock if multi-process ever lands.
 */
const previewLocks = new Map<string, Promise<void>>();

function withPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${repo}\0${prId}`;
  const prev = previewLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  previewLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Serialize catalog DROP/CREATE per dbName so orphan sweep cannot race provision.
 * Taken inside the (repo, prId) lock for lifecycle paths; alone for orphan drops.
 */
const dbNameLocks = new Map<string, Promise<void>>();

function withDbNameLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = dbNameLocks.get(dbName) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  dbNameLocks.set(
    dbName,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function parsePreviewStatus(status: string): Result<PreviewStatus> {
  switch (status) {
    case "provisioning":
    case "ready":
    case "removing":
    case "removed":
    case "error":
      return { ok: true, value: status };
    default:
      return { ok: false, status: 500, error: "unknown_preview_status" };
  }
}

async function getPreviewRow(
  db: StateDb,
  repo: string,
  prId: number,
): Promise<PreviewRow | null> {
  const [existing] = await db
    .select()
    .from(previews)
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    )
    .limit(1);
  return existing ?? null;
}

function toSnapshot(
  row: PreviewRow,
  status: PreviewStatus,
): PreviewSnapshot {
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status,
  };
}

async function markPreviewError(
  db: StateDb,
  repo: string,
  prId: number,
): Promise<void> {
  await db
    .update(previews)
    .set({ status: "error", updatedAt: utcIsoNow() })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );
}

async function markReady(
  db: StateDb,
  repo: string,
  prId: number,
): Promise<PreviewRow> {
  const now = utcIsoNow();
  const [updated] = await db
    .update(previews)
    .set({
      status: "ready",
      // Mint generation when the DB becomes live (covers stuck-provisioning
      // recovery that skips writeProvisioningIntent).
      createdAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    )
    .returning();
  if (!updated) {
    throw new Error("preview_row_missing_on_ready");
  }
  return updated;
}

async function writeProvisioningIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
  dbName: string,
): Promise<PreviewRow> {
  const now = utcIsoNow();
  const [updated] = await deps.db
    .update(previews)
    .set({
      slug: input.slug,
      dbName,
      hostname: input.hostname,
      status: "provisioning",
      appImage: null,
      containerId: null,
      seededAt: null,
      // New generation: TTL means age of this intent, not birth of the row key.
      createdAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
      ),
    )
    .returning();
  if (!updated) {
    throw new Error("preview_row_missing_on_intent_write");
  }
  return updated;
}

/** CREATE under dbName lock, then advance to ready. Caller handles CREATE failure. */
async function createThenReady(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<Result<PreviewSnapshot>> {
  return withDbNameLock(row.dbName, async () => {
    try {
      await deps.previewDb.createDatabase(row.dbName);
    } catch {
      return { ok: false, status: 500, error: "preview_db_create_failed" };
    }
    const ready = await markReady(
      deps.db,
      row.canonicalRepoId,
      row.prId,
    );
    return { ok: true, value: toSnapshot(ready, "ready") };
  });
}

async function establishDatabase(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<Result<PreviewSnapshot>> {
  const result = await createThenReady(deps, row);
  if (!result.ok) {
    await markPreviewError(deps.db, row.canonicalRepoId, row.prId);
  }
  return result;
}

async function provisionUnlocked(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const requestedDbName = previewDbName(input.slug, input.prId);
  let row = await getPreviewRow(deps.db, input.repo, input.prId);

  if (!row) {
    const [inserted] = await deps.db
      .insert(previews)
      .values({
        canonicalRepoId: input.repo,
        prId: input.prId,
        slug: input.slug,
        dbName: requestedDbName,
        hostname: input.hostname,
        status: "provisioning",
      })
      .returning();
    if (!inserted) {
      return { ok: false, status: 500, error: "preview_row_missing" };
    }
    return establishDatabase(deps, inserted);
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;

  switch (status.value) {
    case "removed":
    case "error": {
      const intent = await writeProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      return establishDatabase(deps, intent);
    }
    case "provisioning":
      // Crash window only: CREATE not finished. Do not rewrite identity.
      return createThenReady(deps, row);
    case "ready":
      // Option A: DB intent complete — healthy redeploy is a snapshot no-op.
      return { ok: true, value: toSnapshot(row, "ready") };
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
  }
}

/** Soft-remove (sweep/teardown) vs hard-delete SQLite row (admin drop). */
type DestroyDisposition = "tombstone" | "purge";

/**
 * Drop the preview DB under the dbName lock, then finalize the control-plane
 * row: soft `removed` (tombstone, reclaimable) or hard DELETE (purge).
 * Must run inside withPreviewLock; never unlock between DROP and finalize.
 */
async function destroyPreviewRow(
  deps: LifecycleDeps,
  existing: PreviewRow,
  disposition: DestroyDisposition,
): Promise<Result<TeardownSnapshot>> {
  const repo = existing.canonicalRepoId;
  const prId = existing.prId;

  await deps.db
    .update(previews)
    .set({ status: "removing", updatedAt: utcIsoNow() })
    .where(
      and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
    );

  return withDbNameLock(existing.dbName, async () => {
    try {
      await deps.previewDb.dropDatabase(existing.dbName);
    } catch {
      await markPreviewError(deps.db, repo, prId);
      return { ok: false, status: 500, error: "preview_db_drop_failed" };
    }

    if (disposition === "purge") {
      await deps.db
        .delete(previews)
        .where(
          and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
        );
    } else {
      await deps.db
        .update(previews)
        .set({
          status: "removed",
          containerId: null,
          updatedAt: utcIsoNow(),
        })
        .where(
          and(eq(previews.canonicalRepoId, repo), eq(previews.prId, prId)),
        );
    }

    return { ok: true, value: { ok: true, status: "removed" } };
  });
}

async function teardownUnlocked(
  deps: LifecycleDeps,
  input: TeardownInput,
): Promise<Result<TeardownSnapshot>> {
  const existing = await getPreviewRow(deps.db, input.repo, input.prId);

  if (!existing) {
    return { ok: true, value: { ok: true, status: "removed" } };
  }

  const status = parsePreviewStatus(existing.status);
  if (!status.ok) return status;

  switch (status.value) {
    case "removed":
      return { ok: true, value: { ok: true, status: "removed" } };
    case "provisioning":
    case "ready":
    case "error":
    case "removing":
      break;
  }

  return destroyPreviewRow(deps, existing, "tombstone");
}

export type PurgeSnapshot =
  | { ok: true; status: "removed"; purged: false }
  | { ok: true; status: "removed"; purged: true; slug: string; prId: number };

/**
 * Ensure a preview DB exists for (repo, prId).
 * - removed/error: rewrite identity, CREATE, advance to ready
 * - provisioning: retry CREATE (stuck-create recovery), then ready
 * - ready: snapshot no-op
 * - removing: 409
 */
export function provisionPreview(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  return withPreviewLock(input.repo, input.prId, () =>
    provisionUnlocked(deps, input),
  );
}

export function teardownPreview(
  deps: LifecycleDeps,
  input: TeardownInput,
): Promise<Result<TeardownSnapshot>> {
  return withPreviewLock(input.repo, input.prId, () =>
    teardownUnlocked(deps, input),
  );
}

/**
 * Admin purge: drop the DB and hard-delete the SQLite row under one lock.
 * No soft-remove → unlock → DELETE window (provision cannot reclaim mid-purge).
 * Operator drop is intentionally unversioned — confirm binds to (repo, prId)
 * only; a concurrent redeploy can still be destroyed without a new plan.
 */
export function purgePreview(
  deps: LifecycleDeps,
  input: TeardownInput,
): Promise<Result<PurgeSnapshot>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const existing = await getPreviewRow(deps.db, input.repo, input.prId);
    if (!existing || existing.status === "removed") {
      return {
        ok: true,
        value: { ok: true, status: "removed", purged: false },
      };
    }

    const status = parsePreviewStatus(existing.status);
    if (!status.ok) return status;

    const result = await destroyPreviewRow(deps, existing, "purge");
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        ok: true,
        status: "removed",
        purged: true,
        slug: existing.slug,
        prId: existing.prId,
      },
    };
  });
}

/**
 * Sweep control-plane delete: under the same lock as provision/teardown,
 * re-read and abort unless identity + generation still match, then remove.
 * @returns true if the preview was removed; false if the plan was stale.
 */
export function removePreview(
  deps: LifecycleDeps,
  input: RemovePreviewInput,
): Promise<Result<boolean>> {
  return withPreviewLock(input.repo, input.prId, async () => {
    const existing = await getPreviewRow(deps.db, input.repo, input.prId);
    if (!existing || existing.status === "removed") {
      return { ok: true, value: false };
    }
    if (existing.dbName !== input.expectedDbName) {
      return { ok: true, value: false };
    }
    if (existing.createdAt !== input.expectedCreatedAt) {
      return { ok: true, value: false };
    }

    const status = parsePreviewStatus(existing.status);
    if (!status.ok) return status;

    const result = await destroyPreviewRow(deps, existing, "tombstone");
    if (!result.ok) return result;
    return { ok: true, value: true };
  });
}

/**
 * Orphan catalog DROP under the dbName lock. Aborts if a non-removed
 * preview row claims this name (provision won since plan time).
 * @returns true if DROP ran.
 */
export function dropOrphanDatabase(
  deps: LifecycleDeps,
  dbName: string,
): Promise<boolean> {
  return withDbNameLock(dbName, async () => {
    const [claim] = await deps.db
      .select()
      .from(previews)
      .where(and(eq(previews.dbName, dbName), ne(previews.status, "removed")))
      .limit(1);
    if (claim) return false;
    await deps.previewDb.dropDatabase(dbName);
    return true;
  });
}
