import { and, eq, ne } from "drizzle-orm";
import {
  preparePreviewImage,
  replacePreviewApp,
  type AppDeployNetworks,
  type AppDeployPg,
} from "../app-deployment/replace.ts";
import type { PreviewDocker } from "../docker/port.ts";
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
  docker: PreviewDocker;
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

/** CREATE under dbName lock only. Callers decide error vs leave-provisioning. */
async function ensureDatabase(
  deps: LifecycleDeps,
  row: PreviewRow,
): Promise<Result<true>> {
  return withDbNameLock(row.dbName, async () => {
    try {
      await deps.previewDb.createDatabase(row.dbName);
      return { ok: true, value: true };
    } catch {
      return { ok: false, status: 500, error: "preview_db_create_failed" };
    }
  });
}

async function attachAppContainer(
  deps: LifecycleDeps,
  row: PreviewRow,
  input: {
    hostname: string;
    appImage: string;
    port: number;
  },
): Promise<Result<PreviewSnapshot>> {
  try {
    const { containerId } = await replacePreviewApp(
      {
        docker: deps.docker,
        pg: deps.appDeploy.pg,
        networks: deps.appDeploy.networks,
      },
      {
        slug: row.slug,
        prId: row.prId,
        hostname: input.hostname,
        image: input.appImage,
        dbName: row.dbName,
        port: input.port,
      },
    );
    const now = utcIsoNow();
    // Mint generation when DB+app first become live; keep TTL on ready redeploy.
    const mintGeneration = row.status !== "ready";
    const [updated] = await deps.db
      .update(previews)
      .set({
        hostname: input.hostname,
        appImage: input.appImage,
        containerId,
        status: "ready",
        ...(mintGeneration ? { createdAt: now } : {}),
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

async function provisionUnlocked(
  deps: LifecycleDeps,
  input: ProvisionInput,
  port: number,
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
    const ensured = await ensureDatabase(deps, inserted);
    if (!ensured.ok) {
      await markPreviewError(deps.db, inserted.canonicalRepoId, inserted.prId);
      return ensured;
    }
    return attachAppContainer(deps, inserted, {
      hostname: input.hostname,
      appImage: input.appImage,
      port,
    });
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
      const ensured = await ensureDatabase(deps, intent);
      if (!ensured.ok) {
        await markPreviewError(deps.db, intent.canonicalRepoId, intent.prId);
        return ensured;
      }
      return attachAppContainer(deps, intent, {
        hostname: input.hostname,
        appImage: input.appImage,
        port,
      });
    }
    case "provisioning": {
      // Crash window only: CREATE not finished. Do not rewrite identity.
      // Leave status provisioning on CREATE failure so retry stays possible.
      const ensured = await ensureDatabase(deps, row);
      if (!ensured.ok) return ensured;
      return attachAppContainer(deps, row, {
        hostname: input.hostname,
        appImage: input.appImage,
        port,
      });
    }
    case "ready":
      // Replace app container; keep database and identity (slug/db_name).
      return attachAppContainer(deps, row, {
        hostname: input.hostname,
        appImage: input.appImage,
        port,
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

  // Best-effort container remove outside dbName lock (still under preview lock).
  // Leftover pb-* containers are reclaimed by orphan-container sweep.
  try {
    await deps.docker.removeByName(
      previewContainerName(existing.slug, existing.prId),
    );
  } catch {
    console.warn(
      `preview container remove failed for ${existing.slug} pr=${prId}; continuing with DROP`,
    );
  }

  return withDbNameLock(existing.dbName, async () => {
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
 *
 * Registry pull runs outside the preview lock so a hung pull cannot stall
 * teardown for the same (repo, prId).
 */
export async function provisionPreview(
  deps: LifecycleDeps,
  input: ProvisionInput,
): Promise<Result<PreviewSnapshot>> {
  let port: number;
  try {
    port = await preparePreviewImage(
      deps.docker,
      input.appImage,
      deps.appDeploy.previewPortDefault,
    );
  } catch {
    return withPreviewLock(input.repo, input.prId, async () => {
      const row = await getPreviewRow(deps.db, input.repo, input.prId);
      if (
        row &&
        row.status !== "removed" &&
        row.status !== "removing"
      ) {
        await markPreviewError(deps.db, input.repo, input.prId);
      }
      return { ok: false, status: 500, error: "preview_app_deploy_failed" };
    });
  }

  return withPreviewLock(input.repo, input.prId, () =>
    provisionUnlocked(deps, input, port),
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
