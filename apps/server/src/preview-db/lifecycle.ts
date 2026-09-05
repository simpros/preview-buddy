import { and, eq, ne } from "drizzle-orm";
import {
  replacePreviewApp,
  type AppDeployNetworks,
  type AppDeployPg,
} from "../app-deployment/replace.ts";
import type { DockerClient } from "../docker/port.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { previewContainerName } from "../preview/naming.ts";
import { previewDbName } from "./names.ts";
import type { PreviewDb } from "./port.ts";

function utcIsoNow(): string {
  return new Date().toISOString();
}

/**
 * Preview lifecycle statuses known to this slice.
 * `ready` = DB exists and app container started (health → running is a later slice).
 * Keep `error` (not `failed`).
 */
export type PreviewStatus =
  | "provisioning"
  | "ready"
  | "removing"
  | "removed"
  | "error";

export type TeardownDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  docker: DockerClient;
};

export type LifecycleDeps = TeardownDeps & {
  appDeploy: {
    pg: AppDeployPg;
    networks: AppDeployNetworks;
    previewPortDefault: number;
  };
};

export type ProvisionInput = {
  repo: string;
  prId: number;
  slug: string;
  hostname: string;
  appImage: string;
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

function parsePreviewStatus(status: string): Result<PreviewStatus> {
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

/** CREATE under dbName lock, then start app container and advance to ready. */
async function createThenReady(
  deps: LifecycleDeps,
  row: PreviewRow,
  appImage: string,
  hostname: string,
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
    return attachAppContainer(deps, ready, { hostname, appImage });
  });
}

async function attachAppContainer(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: { hostname: string; appImage: string },
): Promise<Result<PreviewSnapshot>> {
  try {
    const { containerId } = await replacePreviewApp(
      {
        docker: deps.docker,
        pg: deps.appDeploy.pg,
        networks: deps.appDeploy.networks,
        previewPortDefault: deps.appDeploy.previewPortDefault,
      },
      {
        slug: row.slug,
        prId: row.prId,
        hostname: input.hostname,
        image: input.appImage,
        dbName: row.dbName,
      },
    );
    const now = utcIsoNow();
    const [updated] = await deps.db
      .update(previews)
      .set({
        hostname: input.hostname,
        appImage: input.appImage,
        containerId,
        status: "ready",
        updatedAt: now,
      })
      .where(
        and(
          eq(previews.canonicalRepoId, row.canonicalRepoId),
          eq(previews.prId, row.prId),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("preview_row_missing_on_app_attach");
    }
    return { ok: true, value: toSnapshot(updated, "ready") };
  } catch {
    await markPreviewError(deps.db, row.canonicalRepoId, row.prId);
    return { ok: false, status: 500, error: "preview_app_deploy_failed" };
  }
}

async function establishDatabase(
  deps: LifecycleDeps,
  row: PreviewRow,
  appImage: string,
  hostname: string,
): Promise<Result<PreviewSnapshot>> {
  const result = await createThenReady(deps, row, appImage, hostname);
  // App attach marks error itself; only DB create failure needs it here.
  if (!result.ok && result.error === "preview_db_create_failed") {
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
    return establishDatabase(
      deps,
      inserted,
      input.appImage,
      input.hostname,
    );
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
      return establishDatabase(
        deps,
        intent,
        input.appImage,
        input.hostname,
      );
    }
    case "provisioning":
      // Crash window only: CREATE not finished. Do not rewrite identity.
      return createThenReady(
        deps,
        row,
        input.appImage,
        input.hostname,
      );
    case "ready":
      // Replace app container; keep database and identity (slug/db_name).
      return attachAppContainer(deps, row, {
        hostname: input.hostname,
        appImage: input.appImage,
      });
    case "removing":
      return {
        ok: false,
        status: 409,
        error: "preview_teardown_in_progress",
      };
  }
}

async function dropAndMarkRemoved(
  deps: TeardownDeps,
  existing: PreviewRow,
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
      await deps.docker.removeByName(
        previewContainerName(existing.slug, existing.prId),
      );
    } catch {
      await markPreviewError(deps.db, repo, prId);
      return { ok: false, status: 500, error: "preview_app_remove_failed" };
    }

    try {
      await deps.previewDb.dropDatabase(existing.dbName);
    } catch {
      await markPreviewError(deps.db, repo, prId);
      return { ok: false, status: 500, error: "preview_db_drop_failed" };
    }

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

    return { ok: true, value: { ok: true, status: "removed" } };
  });
}

async function teardownUnlocked(
  deps: TeardownDeps,
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

  return dropAndMarkRemoved(deps, existing);
}

/**
 * Ensure a preview DB + app container exist for (repo, prId).
 * - removed/error: rewrite identity, CREATE, start/replace app, advance to ready
 * - provisioning: retry CREATE (stuck-create recovery), then start app → ready
 * - ready: replace app container only (database kept)
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
  deps: TeardownDeps,
  input: TeardownInput,
): Promise<Result<TeardownSnapshot>> {
  return withPreviewLock(input.repo, input.prId, () =>
    teardownUnlocked(deps, input),
  );
}

/**
 * Sweep control-plane delete: under the same lock as provision/teardown,
 * re-read and abort unless identity + generation still match, then remove.
 * @returns true if the preview was removed; false if the plan was stale.
 */
export function removePreview(
  deps: TeardownDeps,
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

    const result = await dropAndMarkRemoved(deps, existing);
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
  deps: TeardownDeps,
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
