import type { GovernanceConfig } from "@sprout/preview-env";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { ForgeClient } from "../forge/client.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
import { previews } from "../infrastructure/db/schema.ts";
import type { PreviewDataVolumes } from "../preview/data-volumes.ts";
import {
  dropOrphanDatabase,
  dropOrphanDataVolume,
  removePreview,
  tryRemovePreview,
  type TeardownDeps,
} from "../preview/lifecycle.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewExpiryReason } from "../preview/types.ts";
import type {
  SweepDeletion,
  SweepPorts,
  SweepPreview,
} from "./reconcile.ts";

export type LiveSweepDeps = {
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: Pick<PreviewAppOps, "list" | "remove">;
  dataVolumes: PreviewDataVolumes;
  forge: ForgeClient;
  legacyTtlMs: number;
  governance: GovernanceConfig;
  log?: SweepPorts["log"];
};

function teardownDeps(deps: LiveSweepDeps): TeardownDeps {
  return {
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    dataVolumes: deps.dataVolumes,
  };
}

async function removeControlPlane(
  deps: LiveSweepDeps,
  deletion: Extract<SweepDeletion, { reason: PreviewExpiryReason }>,
): Promise<boolean> {
  const result = await removePreview(
    teardownDeps(deps),
    controlPlaneInput(deletion),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** Non-blocking expiry removal: false when a deploy holds the preview lock. */
async function tryRemoveControlPlane(
  deps: LiveSweepDeps,
  deletion: Extract<SweepDeletion, { reason: PreviewExpiryReason }>,
): Promise<boolean> {
  const result = await tryRemovePreview(
    teardownDeps(deps),
    controlPlaneInput(deletion),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function controlPlaneInput(
  deletion: Extract<SweepDeletion, { reason: PreviewExpiryReason }>,
) {
  return {
    repo: deletion.canonicalRepoId,
    prId: deletion.prId,
    expectedDbName: deletion.dbName,
    expectedCreatedAt: deletion.createdAt,
    expectedLastActivityAt: deletion.lastActivityAt,
    expiryReason: deletion.reason,
  };
}

export function createLiveSweepPorts(deps: LiveSweepDeps): SweepPorts {
  return {
    legacyTtlMs: deps.legacyTtlMs,
    governance: deps.governance,
    log: deps.log,
    listPreviews: async () => {
      const rows = await deps.db.select().from(previews);
      const out: SweepPreview[] = [];
      for (const row of rows) {
        const createdAtMs = parseUnambiguousUtcMs(row.createdAt);
        if (createdAtMs === null) {
          deps.log?.(
            `sweep preview invalid createdAt ${row.createdAt} (${row.slug}:${row.prId})`,
          );
        }
        out.push({
          canonicalRepoId: row.canonicalRepoId,
          prId: row.prId,
          slug: row.slug,
          dbName: row.dbName,
          createdAt: row.createdAt,
          createdAtMs,
          lastActivityAt: row.lastActivityAt ?? null,
          status: row.status,
          lastActivityMs: parseUnambiguousUtcMs(row.lastActivityAt ?? ""),
          ttlMs: row.ttlMs ?? null,
          idleMs: row.idleMs ?? null,
        });
      }
      return out;
    },
    listCatalogDatabases: async () =>
      (await deps.previewDb.listPreviewDatabases()).map(
        ({ slug, prId, dbName }) => ({ slug, prId, dbName }),
      ),
    listDataVolumes: async () => await deps.dataVolumes.listDataVolumes(),
    listPreviewContainers: async () =>
      (await deps.app.list()).map(({ slug, prId }) => ({
        slug,
        prId,
      })),
    listOpenPrIds: (canonicalRepoId) =>
      deps.forge.listOpenPrIds(canonicalRepoId),
    drop: async (deletion: SweepDeletion) => {
      try {
        return await dropDeletion(deps, deletion);
      } catch (error) {
        throw new Error(
          `teardown incomplete: ${deletion.slug}:${deletion.prId}: ${String(error)}`,
        );
      }
    },
  };
}

async function dropDeletion(
  deps: LiveSweepDeps,
  deletion: SweepDeletion,
): Promise<boolean> {
  switch (deletion.reason) {
    case "sweep:ttl-expired":
    case "sweep:idle-expired":
      return tryRemoveControlPlane(deps, deletion);
    case "sweep:pr-not-open": {
      const open = await deps.forge.listOpenPrIds(deletion.canonicalRepoId);
      if (open.includes(deletion.prId)) return false;
      return removeControlPlane(deps, deletion);
    }
    case "sweep:orphan-db":
      return dropOrphanDatabase(teardownDeps(deps), deletion.dbName);
    case "sweep:orphan-container":
      await deps.app.remove(deletion.slug, deletion.prId);
      return true;
    case "sweep:orphan-data-volume":
      return dropOrphanDataVolume(teardownDeps(deps), deletion);
  }
}
