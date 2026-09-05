import { eq, and } from "drizzle-orm";
import type { ForgeClient } from "../forge/client.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { withPreviewLock } from "../preview-db/lifecycle.ts";
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

async function teardownResources(
  deps: LiveSweepDeps,
  deletion: SweepDeletion,
): Promise<void> {
  // Best-effort each resource step; leave SQLite non-removed on any
  // failure so the next pass can retry.
  let failLabel = `${deletion.slug}:${deletion.prId}`;
  const steps: Promise<void>[] = [];

  const pushDropDb = (dbName: string) => {
    failLabel = dbName;
    steps.push(
      deps.previewDb.dropDatabase(dbName).catch((error) => {
        deps.log?.(`sweep drop database failed: ${String(error)}`, deletion);
        throw error;
      }),
    );
  };

  const pushRemoveContainer = () => {
    steps.push(
      deps.containers
        .remove({ slug: deletion.slug, prId: deletion.prId })
        .catch((error) => {
          deps.log?.(
            `sweep remove container failed: ${String(error)}`,
            deletion,
          );
          throw error;
        }),
    );
  };

  switch (deletion.reason) {
    case "sweep:ttl-expired":
    case "sweep:pr-not-open":
      pushDropDb(deletion.dbName);
      pushRemoveContainer();
      break;
    case "sweep:orphan-db":
      pushDropDb(deletion.dbName);
      break;
    case "sweep:orphan-container":
      pushRemoveContainer();
      break;
  }

  const results = await Promise.allSettled(steps);
  if (results.some((r) => r.status === "rejected")) {
    throw new Error(`teardown incomplete: ${failLabel}`);
  }
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
      const run = async () => {
        await teardownResources(deps, deletion);
        // Orphans have no control-plane row.
        if (
          deletion.reason !== "sweep:ttl-expired" &&
          deletion.reason !== "sweep:pr-not-open"
        ) {
          return;
        }

        await deps.db
          .update(previews)
          .set({
            status: "removed",
            containerId: null,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(previews.canonicalRepoId, deletion.canonicalRepoId),
              eq(previews.prId, deletion.prId),
            ),
          );
      };

      // Same per-(repo, prId) lock as provision/teardown so sweep cannot
      // DROP under an in-flight CREATE (and vice versa).
      if (
        deletion.reason === "sweep:ttl-expired" ||
        deletion.reason === "sweep:pr-not-open"
      ) {
        await withPreviewLock(
          deletion.canonicalRepoId,
          deletion.prId,
          run,
        );
        return;
      }

      await run();
    },
  };
}
