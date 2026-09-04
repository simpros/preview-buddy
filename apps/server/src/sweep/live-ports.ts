import { eq, and } from "drizzle-orm";
import type { ForgeClient } from "../forge/client.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import type { ContainerPorts } from "../preview/containers.ts";
import type { PostgresAdmin } from "../preview/postgres-admin.ts";
import type {
  SweepDeletion,
  SweepPorts,
  SweepPreview,
} from "./reconcile.ts";

export type LiveSweepDeps = {
  db: StateDb;
  postgres: PostgresAdmin;
  containers: ContainerPorts;
  forge: ForgeClient;
  ttlHours: number;
  log?: SweepPorts["log"];
};

/** Unambiguous UTC instant: ends with Z or numeric ±HH:MM offset. */
const UNAMBIGUOUS_UTC_INSTANT = /Z|[+-]\d{2}:\d{2}$/;

function parseCreatedAtMs(createdAt: string): number | null {
  if (!UNAMBIGUOUS_UTC_INSTANT.test(createdAt)) return null;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}

async function teardownResources(
  deps: LiveSweepDeps,
  deletion: SweepDeletion,
): Promise<void> {
  // Best-effort each resource step; leave SQLite non-removed on any
  // failure so the next pass can retry.
  let failLabel = `${deletion.slug}:${deletion.prId}`;
  const steps: Promise<void>[] = [];

  if ("dbName" in deletion) {
    failLabel = deletion.dbName;
    steps.push(
      deps.postgres.dropDatabase(deletion.dbName).catch((error) => {
        deps.log?.(`sweep drop database failed: ${String(error)}`, deletion);
        throw error;
      }),
    );
  }
  if (deletion.reason !== "sweep:orphan-db") {
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
        const createdAtMs = parseCreatedAtMs(row.createdAt);
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
    listCatalogDatabases: () => deps.postgres.listPreviewDatabases(),
    listPreviewContainers: () => deps.containers.listPreviewContainers(),
    listOpenPrIds: (canonicalRepoId) =>
      deps.forge.listOpenPrIds(canonicalRepoId),
    drop: async (deletion: SweepDeletion) => {
      await teardownResources(deps, deletion);
      // Orphans have no control-plane row.
      if (!("canonicalRepoId" in deletion)) return;

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
    },
  };
}
