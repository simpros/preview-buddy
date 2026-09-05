import { and, eq, inArray } from "drizzle-orm";
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

/** Mark error only from the status we expect; ignore lost races. */
async function markPreviewError(
  db: StateDb,
  repo: string,
  prId: number,
  from: PreviewStatus[],
): Promise<void> {
  await db
    .update(previews)
    .set({ status: "error", updatedAt: utcIsoNow() })
    .where(
      and(
        eq(previews.canonicalRepoId, repo),
        eq(previews.prId, prId),
        inArray(previews.status, from),
      ),
    );
}

/**
 * CAS rewrite of identity from removed|error → provisioning.
 * Returns the new row, or null if another writer won the race.
 */
async function casWriteProvisioningIntent(
  deps: LifecycleDeps,
  input: ProvisionInput,
  dbName: string,
): Promise<PreviewRow | null> {
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
        inArray(previews.status, ["removed", "error"]),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * CREATE only while status is still provisioning; re-read for the response.
 * If teardown won mid-flight, best-effort DROP our CREATE and 409.
 */
async function createDbForRow(
  deps: LifecycleDeps,
  repo: string,
  prId: number,
): Promise<Result<PreviewSnapshot>> {
  const before = await getPreviewRow(deps.db, repo, prId);
  if (!before) {
    return { ok: false, status: 500, error: "preview_row_missing" };
  }
  const beforeStatus = parsePreviewStatus(before.status);
  if (!beforeStatus.ok) return beforeStatus;
  if (beforeStatus.value !== "provisioning") {
    if (beforeStatus.value === "removing") {
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
    }
    return { ok: false, status: 409, error: "preview_conflict" };
  }

  try {
    await deps.previewDb.createDatabase(before.dbName);
  } catch {
    await markPreviewError(deps.db, repo, prId, ["provisioning"]);
    return { ok: false, status: 500, error: "preview_db_create_failed" };
  }

  const after = await getPreviewRow(deps.db, repo, prId);
  if (!after) {
    return { ok: false, status: 500, error: "preview_row_missing" };
  }
  const afterStatus = parsePreviewStatus(after.status);
  if (!afterStatus.ok) return afterStatus;

  if (afterStatus.value !== "provisioning") {
    // Teardown (or other writer) won after our CREATE — undo catalog orphan.
    try {
      await deps.previewDb.dropDatabase(before.dbName);
    } catch {
      // best-effort; control plane already diverged
    }
    if (afterStatus.value === "removing" || afterStatus.value === "removed") {
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
    }
    return { ok: false, status: 409, error: "preview_conflict" };
  }

  return { ok: true, value: toSnapshot(after, afterStatus.value) };
}

async function continueProvision(
  deps: LifecycleDeps,
  input: ProvisionInput,
  requestedDbName: string,
  status: PreviewStatus,
): Promise<Result<PreviewSnapshot>> {
  switch (status) {
    case "removed":
    case "error": {
      const cas = await casWriteProvisioningIntent(
        deps,
        input,
        requestedDbName,
      );
      if (!cas) {
        // Lost CAS — re-read and dispatch on the winner's state.
        const again = await getPreviewRow(deps.db, input.repo, input.prId);
        if (!again) {
          return { ok: false, status: 500, error: "preview_row_missing" };
        }
        const againStatus = parsePreviewStatus(again.status);
        if (!againStatus.ok) return againStatus;
        return continueProvision(
          deps,
          input,
          requestedDbName,
          againStatus.value,
        );
      }
      return createDbForRow(deps, input.repo, input.prId);
    }
    case "provisioning":
      // Option B: always retry CREATE with existing identity.
      return createDbForRow(deps, input.repo, input.prId);
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
  }
}

/**
 * Ensure a preview DB exists for (repo, prId).
 * - removed/error: CAS rewrite identity, then CREATE
 * - provisioning: retry CREATE with existing identity (stuck-create recovery)
 * - removing: 409 (teardown owns the row)
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
    return continueProvision(deps, input, requestedDbName, status.value);
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
  return continueProvision(deps, input, requestedDbName, status.value);
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

  if (status.value === "removed") {
    return { ok: true, value: { ok: true, status: "removed" } };
  }

  // CAS mark removing before DDL so stuck teardowns are detectable / retryable.
  const [marked] = await deps.db
    .update(previews)
    .set({ status: "removing", updatedAt: utcIsoNow() })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
        inArray(previews.status, ["provisioning", "error", "removing"]),
      ),
    )
    .returning();

  if (!marked) {
    // CAS set is every non-removed status; failure means already removed.
    return { ok: true, value: { ok: true, status: "removed" } };
  }

  const dbName = marked.dbName;

  try {
    await deps.previewDb.dropDatabase(dbName);
  } catch {
    await markPreviewError(deps.db, input.repo, input.prId, ["removing"]);
    return { ok: false, status: 500, error: "preview_db_drop_failed" };
  }

  const [removed] = await deps.db
    .update(previews)
    .set({ status: "removed", updatedAt: utcIsoNow() })
    .where(
      and(
        eq(previews.canonicalRepoId, input.repo),
        eq(previews.prId, input.prId),
        eq(previews.status, "removing"),
      ),
    )
    .returning();

  if (!removed) {
    const again = await getPreviewRow(deps.db, input.repo, input.prId);
    if (again?.status === "removed") {
      return { ok: true, value: { ok: true, status: "removed" } };
    }
    // Lost race after DROP — still report success; catalog is clean.
  }

  return { ok: true, value: { ok: true, status: "removed" } };
}
