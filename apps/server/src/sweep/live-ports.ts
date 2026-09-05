import type { ForgeClient } from "../forge/client.ts";
import type { DockerClient } from "../docker/port.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  dropOrphanDatabase,
  removePreview,
  type TeardownDeps,
} from "../preview-db/lifecycle.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import type { ContainerPorts } from "../preview/containers.ts";
import type {
  SweepDeletion,
  SweepPorts,
  SweepPreview,
} from "./reconcile.ts";

export type LiveSweepDeps = {
  db: StateDb;
  previewDb: PreviewDb;
  docker: DockerClient;
  containers: ContainerPorts;
  forge: ForgeClient;
  ttlHours: number;
  log?: SweepPorts["log"];
};

function teardownDeps(deps: LiveSweepDeps): TeardownDeps {
  return {
    db: deps.db,
    previewDb: deps.previewDb,
    docker: deps.docker,
  };
}

async function removeControlPlane(
  deps: LiveSweepDeps,
  deletion: Extract<
    SweepDeletion,
    { reason: "sweep:ttl-expired" | "sweep:pr-not-open" }
  >,
): Promise<boolean> {
  // Control-plane remove stays under lifecycle locks; Docker is best-effort
  // after unlock so a hung container API cannot stall the preview/dbName queues.
  const result = await removePreview(teardownDeps(deps), {
    repo: deletion.canonicalRepoId,
    prId: deletion.prId,
    expectedDbName: deletion.dbName,
    expectedCreatedAt: deletion.createdAt,
  });
  if (!result.ok) {
    deps.log?.(`sweep drop database failed: ${result.error}`, deletion);
    throw new Error(`teardown incomplete: ${deletion.dbName}`);
  }
  if (!result.value) return false;

  try {
    await deps.containers.remove({
      slug: deletion.slug,
      prId: deletion.prId,
    });
  } catch (error) {
    // Leave for the next orphan-container pass; DB is already gone.
    deps.log?.(
      `sweep remove container failed: ${String(error)}`,
      deletion,
    );
  }
  return true;
}

export function createLiveSweepPorts(deps: LiveSweepDeps): SweepPorts {
  return {
    ttlHours: deps.ttlHours,
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
          status: row.status,
        });
      }
      return out;
    },
    listCatalogDatabases: async () =>
      (await deps.previewDb.listPreviewDatabases()).map(
        ({ slug, prId, dbName }) => ({ slug, prId, dbName }),
      ),
    listPreviewContainers: async () =>
      (await deps.containers.listPreviewContainers()).map(({ slug, prId }) => ({
        slug,
        prId,
      })),
    listOpenPrIds: (canonicalRepoId) =>
      deps.forge.listOpenPrIds(canonicalRepoId),
    drop: async (deletion: SweepDeletion) => {
      switch (deletion.reason) {
        case "sweep:ttl-expired":
          return removeControlPlane(deps, deletion);
        case "sweep:pr-not-open": {
          // Forge outside the preview lock — under lock only checks generation.
          const open = await deps.forge.listOpenPrIds(
            deletion.canonicalRepoId,
          );
          if (open.includes(deletion.prId)) return false;
          return removeControlPlane(deps, deletion);
        }
        case "sweep:orphan-db": {
          try {
            return await dropOrphanDatabase(
              teardownDeps(deps),
              deletion.dbName,
            );
          } catch (error) {
            deps.log?.(
              `sweep drop database failed: ${String(error)}`,
              deletion,
            );
            throw new Error(`teardown incomplete: ${deletion.dbName}`);
          }
        }
        case "sweep:orphan-container": {
          try {
            await deps.containers.remove({
              slug: deletion.slug,
              prId: deletion.prId,
            });
            return true;
          } catch (error) {
            deps.log?.(
              `sweep remove container failed: ${String(error)}`,
              deletion,
            );
            throw new Error(
              `teardown incomplete: ${deletion.slug}:${deletion.prId}`,
            );
          }
        }
      }
    },
  };
}
