import { isForgeApiError } from "../forge/types.ts";
import type { CatalogContainer } from "../preview/containers.ts";
import type { CatalogDatabase } from "../preview/postgres-admin.ts";

export type { CatalogContainer, CatalogDatabase };

export type SweepReason =
  | "sweep:pr-not-open"
  | "sweep:ttl-expired"
  | "sweep:orphan-db"
  | "sweep:orphan-container";

export type SweepPreview = {
  canonicalRepoId: string;
  prId: number;
  slug: string;
  dbName: string;
  containerId: string | null;
  /** null = unparsable createdAt; skip TTL, still protect orphans / forge. */
  createdAtMs: number | null;
  status: string;
};

export type SweepDeletion =
  | {
      reason: "sweep:pr-not-open" | "sweep:ttl-expired";
      canonicalRepoId: string;
      prId: number;
      slug: string;
      dbName: string;
    }
  | { reason: "sweep:orphan-db"; slug: string; prId: number; dbName: string }
  | {
      reason: "sweep:orphan-container";
      slug: string;
      prId: number;
    };

export type SweepPorts = {
  listPreviews: () => Promise<SweepPreview[]>;
  listCatalogDatabases: () => Promise<CatalogDatabase[]>;
  listPreviewContainers: () => Promise<CatalogContainer[]>;
  listOpenPrIds: (canonicalRepoId: string) => Promise<number[]>;
  drop: (deletion: SweepDeletion) => Promise<void>;
  ttlHours: number;
  log?: (message: string, deletion?: SweepDeletion) => void;
};

export type SweepPassResult = {
  /** Canonical repo ids whose forge listOpenPrIds call failed. */
  forgeRepoFailures: string[];
  deletions: SweepDeletion[];
};

async function dropSettled(
  ports: SweepPorts,
  candidates: SweepDeletion[],
  successLog: (deletion: SweepDeletion) => string,
): Promise<SweepDeletion[]> {
  const results = await Promise.allSettled(
    candidates.map(async (deletion) => {
      await ports.drop(deletion);
      return deletion;
    }),
  );

  const succeeded: SweepDeletion[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const deletion = candidates[i]!;
    if (result.status === "fulfilled") {
      ports.log?.(successLog(deletion), deletion);
      succeeded.push(deletion);
    } else {
      ports.log?.(
        `sweep drop failed (${deletion.reason}): ${String(result.reason)}`,
        deletion,
      );
    }
  }
  return succeeded;
}

function planOrphans(
  previewKeys: Set<string>,
  catalog: CatalogDatabase[],
  containers: CatalogContainer[],
): SweepDeletion[] {
  const out: SweepDeletion[] = [];
  for (const db of catalog) {
    if (previewKeys.has(`${db.slug}:${db.prId}`)) continue;
    out.push({
      reason: "sweep:orphan-db",
      slug: db.slug,
      prId: db.prId,
      dbName: db.dbName,
    });
  }
  for (const container of containers) {
    if (previewKeys.has(`${container.slug}:${container.prId}`)) continue;
    out.push({
      reason: "sweep:orphan-container",
      slug: container.slug,
      prId: container.prId,
    });
  }
  return out;
}

export async function runSweepPass(ports: SweepPorts): Promise<SweepPassResult> {
  const [previewsResult, catalogResult, containersResult] =
    await Promise.allSettled([
      ports.listPreviews(),
      ports.listCatalogDatabases(),
      ports.listPreviewContainers(),
    ]);

  if (previewsResult.status === "rejected") throw previewsResult.reason;

  const previews = previewsResult.value;
  const catalog =
    catalogResult.status === "fulfilled" ? catalogResult.value : [];
  if (catalogResult.status === "rejected") {
    ports.log?.(
      `sweep catalog databases failed: ${String(catalogResult.reason)}`,
    );
  }
  const containers =
    containersResult.status === "fulfilled" ? containersResult.value : [];
  if (containersResult.status === "rejected") {
    ports.log?.(
      `sweep preview containers failed: ${String(containersResult.reason)}`,
    );
  }

  const cutoff = Date.now() - ports.ttlHours * 60 * 60 * 1000;
  const previewKeys = new Set<string>();
  const remainingPreviews: SweepPreview[] = [];
  const ttlDeletions: SweepDeletion[] = [];

  for (const preview of previews) {
    if (preview.status === "removed") continue;

    previewKeys.add(`${preview.slug}:${preview.prId}`);
    if (preview.createdAtMs !== null && preview.createdAtMs < cutoff) {
      ttlDeletions.push({
        reason: "sweep:ttl-expired",
        canonicalRepoId: preview.canonicalRepoId,
        prId: preview.prId,
        slug: preview.slug,
        dbName: preview.dbName,
      });
    } else {
      remainingPreviews.push(preview);
    }
  }

  const orphanDeletions = planOrphans(previewKeys, catalog, containers);

  const candidateRepos = [
    ...new Set(remainingPreviews.map((p) => p.canonicalRepoId)),
  ];

  const forgeResults = await Promise.allSettled(
    candidateRepos.map(
      async (repo) =>
        [repo, new Set(await ports.listOpenPrIds(repo))] as const,
    ),
  );

  const openByRepo = new Map<string, Set<number>>();
  const forgeRepoFailures: string[] = [];
  for (let i = 0; i < forgeResults.length; i++) {
    const result = forgeResults[i]!;
    const repo = candidateRepos[i]!;
    if (result.status === "fulfilled") {
      openByRepo.set(result.value[0], result.value[1]);
      continue;
    }
    if (!isForgeApiError(result.reason)) throw result.reason;
    forgeRepoFailures.push(repo);
    ports.log?.(
      `sweep forge repo failed: ${repo} (${String(result.reason)})`,
    );
  }

  const prNotOpenDeletions: SweepDeletion[] = [];
  for (const preview of remainingPreviews) {
    // Missing map entry = forge failed for that repo — do not delete.
    const openSet = openByRepo.get(preview.canonicalRepoId);
    if (!openSet || openSet.has(preview.prId)) continue;

    prNotOpenDeletions.push({
      reason: "sweep:pr-not-open",
      canonicalRepoId: preview.canonicalRepoId,
      prId: preview.prId,
      slug: preview.slug,
      dbName: preview.dbName,
    });
  }

  const deletions = await dropSettled(
    ports,
    [...ttlDeletions, ...orphanDeletions, ...prNotOpenDeletions],
    (d) => `deleted (${d.reason})`,
  );

  return { forgeRepoFailures, deletions };
}
