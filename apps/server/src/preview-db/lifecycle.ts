import { and, eq } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewDbName } from "./names.ts";
import type { PreviewDb } from "./port.ts";

function utcIsoNow(): string {
  return new Date().toISOString();
}

/** Preview lifecycle statuses known to this slice. Keep `error` (not `failed`). */
export type PreviewStatus =
  | "provisioning"
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

type PreviewRow = typeof previews.$inferSelect;

/**
 * Serialize provision/teardown/sweep control-plane drops per (repo, prId).
 * ADR 0001: one gateway process — in-process queue is the concurrency design.
 * ponytail: global Map; upgrade to shared lock if multi-process ever lands.
 */
const previewLocks = new Map<string, Promise<void>>();

export function withPreviewLock<T>(
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

function parsePreviewStatus(status: string): Result<PreviewStatus> {
  switch (status) {
    case "provisioning":
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

async function writeProvisioningIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
  dbName: string,
): Promise<PreviewRow> {
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
      updatedAt: utcIsoNow(),
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

/**
 * @param markErrorOnFailure — true only when this critical section wrote
 *   provisioning intent (establish). Ensure/retry leaves status alone.
 */
async function createAndSnapshot(
  deps: LifecycleDeps,
  row: PreviewRow,
  markErrorOnFailure: boolean,
): Promise<Result<PreviewSnapshot>> {
  try {
    await deps.previewDb.createDatabase(row.dbName);
  } catch {
    if (markErrorOnFailure) {
      await markPreviewError(
        deps.db,
        row.canonicalRepoId,
        row.prId,
      );
    }
    return { ok: false, status: 500, error: "preview_db_create_failed" };
  }
  return { ok: true, value: toSnapshot(row, "provisioning") };
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
    row = inserted;
    return createAndSnapshot(deps, row, true);
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
      return createAndSnapshot(deps, intent, true);
    }
    case "provisioning":
      // Option B: retry CREATE; do not poison a prior success with error.
      return createAndSnapshot(deps, row, false);
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
  }
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
    case "error":
    case "removing":
      break;
  }

  await deps.db
    .update(previews)
    .set({ status: "removing", updatedAt: utcIsoNow() })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
      ),
    );

  try {
    await deps.previewDb.dropDatabase(existing.dbName);
  } catch {
    await markPreviewError(deps.db, input.repo, input.prId);
    return { ok: false, status: 500, error: "preview_db_drop_failed" };
  }

  await deps.db
    .update(previews)
    .set({ status: "removed", updatedAt: utcIsoNow() })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
      ),
    );

  return { ok: true, value: { ok: true, status: "removed" } };
}

/**
 * Ensure a preview DB exists for (repo, prId).
 * - removed/error: rewrite identity, then CREATE
 * - provisioning: retry CREATE with existing identity (stuck-create recovery)
 * - removing: 409 (teardown owns the row)
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
