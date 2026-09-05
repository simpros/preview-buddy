import { and, eq, sql } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewDbName } from "./names.ts";
import type { PreviewDb } from "./port.ts";

const now = sql`(datetime('now'))`;

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
  status: string;
};

export type TeardownSnapshot = {
  ok: true;
  status: "removed";
};

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

type PreviewRow = typeof previews.$inferSelect;

/** Statuses where deploy may rewrite identity and (re)provision. */
export function canProvisionDb(
  status: PreviewStatus,
): status is "removed" | "error" {
  switch (status) {
    case "removed":
    case "error":
      return true;
    case "provisioning":
    case "removing":
      return false;
  }
}

/** Statuses that imply a live (or in-flight) preview DB intent. */
export function hasLiveDbIntent(
  status: PreviewStatus,
): status is "provisioning" | "removing" {
  switch (status) {
    case "provisioning":
    case "removing":
      return true;
    case "removed":
    case "error":
      return false;
  }
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

function toSnapshot(row: PreviewRow): PreviewSnapshot {
  return {
    ok: true,
    canonical_repo_id: row.canonicalRepoId,
    pr_id: row.prId,
    slug: row.slug,
    db_name: row.dbName,
    hostname: row.hostname,
    status: row.status,
  };
}

async function createDbForRow(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<Result<PreviewSnapshot>> {
  try {
    await deps.previewDb.createDatabase(row.dbName);
  } catch {
    await markPreviewError(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "preview_db_create_failed" };
  }
  return {
    ok: true,
    value: { ...toSnapshot(row), status: "provisioning" },
  };
}

async function writeProvisioningIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
  dbName: string,
): Promise<void> {
  await deps.db
    .update(previews)
    .set({
      slug: input.slug,
      dbName,
      hostname: input.hostname,
      status: "provisioning",
      appImage: null,
      containerId: null,
      seededAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
      ),
    );
}

async function continueProvision(
  deps: LifecycleDeps,
  input: ProvisionInput,
  row: PreviewRow,
  requestedDbName: string,
  status: PreviewStatus,
): Promise<Result<PreviewSnapshot>> {
  if (canProvisionDb(status)) {
    await writeProvisioningIntent(deps, input, requestedDbName);
    return createDbForRow(deps, {
      ...row,
      slug: input.slug,
      dbName: requestedDbName,
      hostname: input.hostname,
      status: "provisioning",
    });
  }

  if (hasLiveDbIntent(status)) {
    // Option B: provisioning always retries CREATE; removing is left alone.
    if (status === "provisioning") {
      return createDbForRow(deps, row);
    }
    return { ok: true, value: toSnapshot(row) };
  }

  // Predicates must cover every PreviewStatus — force a decision for new ones.
  const _exhaustive: never = status;
  return _exhaustive;
}

/**
 * Ensure a preview DB exists for (repo, prId).
 * - removed/error: rewrite identity, then CREATE
 * - provisioning: retry CREATE with existing identity (stuck-create recovery)
 * - removing: return current row (do not clobber teardown)
 */
export async function provisionPreview(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  const requestedDbName = previewDbName(input.slug, input.prId);
  let row = await getPreviewRow(deps.db, input.repo, input.prId);

  if (row) {
    const status = parsePreviewStatus(row.status);
    if (!status.ok) return status;
    return continueProvision(deps, input, row, requestedDbName, status.value);
  }

  // First insert — ignore conflict so parallel deploys never 500.
  await deps.db
    .insert(previews)
    .values({
      canonicalRepoId: input.repo,
      prId: input.prId,
      slug: input.slug,
      dbName: requestedDbName,
      hostname: input.hostname,
      status: "provisioning",
    })
    .onConflictDoNothing({
      target: [previews.canonicalRepoId, previews.prId],
    });

  row = await getPreviewRow(deps.db, input.repo, input.prId);
  if (!row) {
    return { ok: false, status: 500, error: "preview_row_missing" };
  }

  const status = parsePreviewStatus(row.status);
  if (!status.ok) return status;
  return continueProvision(deps, input, row, requestedDbName, status.value);
}

export async function teardownPreview(
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
    case "removing":
    case "error":
      break;
  }

  // Mark removing before DDL so stuck teardowns are detectable / retryable.
  await deps.db
    .update(previews)
    .set({ status: "removing", updatedAt: now })
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
    .set({ status: "removed", updatedAt: now })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
      ),
    );

  return { ok: true, value: { ok: true, status: "removed" } };
}
