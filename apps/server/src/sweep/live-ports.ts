import type { ForgeClient } from "../forge/client.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  dropOrphanDatabase,
  removePreview,
  type LifecycleDeps,
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
  containers: ContainerPorts;
  forge: ForgeClient;
  ttlHours: number;
  log?: SweepPorts["log"];
};

function lifecycleDeps(deps: LiveSweepDeps): LifecycleDeps {
  return { db: deps.db, previewDb: deps.previewDb };
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
        case "sweep:pr-not-open": {
          const cutoff =
            Date.now() - deps.ttlHours * 60 * 60 * 1000;
          const result = await removePreview(lifecycleDeps(deps), {
            repo: deletion.canonicalRepoId,
            prId: deletion.prId,
            expectedDbName: deletion.dbName,
            confirm: async (row) => {
              if (deletion.reason === "sweep:ttl-expired") {
                const ms = parseUnambiguousUtcMs(row.createdAt);
                return ms !== null && ms < cutoff;
              }
              // Re-check forge under the lock so a reopen cannot race.
              const open = await deps.forge.listOpenPrIds(
                deletion.canonicalRepoId,
              );
              return !open.includes(deletion.prId);
            },
            also: async (row) => {
              try {
                await deps.containers.remove({
                  slug: row.slug,
                  prId: row.prId,
                });
              } catch (error) {
                deps.log?.(
                  `sweep remove container failed: ${String(error)}`,
                  deletion,
                );
                throw error;
              }
            },
          });
          if (!result.ok) {
            deps.log?.(
              `sweep drop database failed: ${result.error}`,
              deletion,
            );
            throw new Error(`teardown incomplete: ${deletion.dbName}`);
          }
          return result.value;
        }
        case "sweep:orphan-db": {
          try {
            return await dropOrphanDatabase(
              lifecycleDeps(deps),
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
