import type { DataVolumeRef, GovernanceConfig } from "@sprout/preview-env";
import { governanceStatus } from "@sprout/preview-env";
import { isForgeApiError } from "../forge/types.ts";

export type SweepReason =
  | "sweep:pr-not-open"
  | "sweep:ttl-expired"
  | "sweep:idle-expired"
  | "sweep:orphan-db"
  | "sweep:orphan-container"
  | "sweep:orphan-data-volume";

export type PreviewRef = { slug: string; prId: number };

export type CatalogDbRef = PreviewRef & { dbName: string };

export type SweepPreview = {
  canonicalRepoId: string;
  prId: number;
  slug: string;
  dbName: string | null;
  createdAt: string;
  createdAtMs: number | null;
  status: string;
  lastActivityMs?: number | null;
  expiresAtMs?: number | null;
  ttlMs?: number | null;
  idleMs?: number | null;
};

export type SweepDeletion =
  | {
      reason: "sweep:pr-not-open" | "sweep:ttl-expired" | "sweep:idle-expired";
      canonicalRepoId: string;
      prId: number;
      slug: string;
      dbName: string | null;
      createdAt: string;
    }
  | { reason: "sweep:orphan-db"; slug: string; prId: number; dbName: string }
  | {
      reason: "sweep:orphan-container" | "sweep:orphan-data-volume";
      slug: string;
      prId: number;
    };

export type SweepPorts = {
  listPreviews: () => Promise<SweepPreview[]>;
  listCatalogDatabases: () => Promise<CatalogDbRef[]>;
  listDataVolumes: () => Promise<DataVolumeRef[]>;
  listPreviewContainers: () => Promise<PreviewRef[]>;
  listOpenPrIds: (canonicalRepoId: string) => Promise<number[]>;
  /** True if resources were removed; false if the plan was stale. */
  drop: (deletion: SweepDeletion) => Promise<boolean>;
  ttlHours: number;
  governance?: GovernanceConfig;
  log?: (message: string, deletion?: SweepDeletion) => void;
};

export type SweepPassResult = {
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
      const removed = await ports.drop(deletion);
      return { deletion, removed };
    }),
  );

  const succeeded: SweepDeletion[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const deletion = candidates[i]!;
    if (result.status === "fulfilled") {
      // Stale plan — not a success.
      if (!result.value.removed) continue;
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

export type OrphanDeletion = Extract<
  SweepDeletion,
  {
    reason: "sweep:orphan-db" | "sweep:orphan-container" | "sweep:orphan-data-volume";
  }
>;

export function planOrphans(input: {
  previewKeys: Set<string>;
  catalog: CatalogDbRef[];
  containers: PreviewRef[];
  dataVolumes: DataVolumeRef[];
}): OrphanDeletion[] {
  const out: OrphanDeletion[] = [];
  for (const db of input.catalog) {
    if (input.previewKeys.has(`${db.slug}:${db.prId}`)) continue;
    out.push({
      reason: "sweep:orphan-db",
      slug: db.slug,
      prId: db.prId,
      dbName: db.dbName,
    });
  }
  out.push(
    ...keyedRefs(input.previewKeys, input.containers, "sweep:orphan-container"),
    ...keyedRefs(
      input.previewKeys,
      input.dataVolumes,
      "sweep:orphan-data-volume",
    ),
  );
  return out;
}

/** One deduped slug:prId loop for every per-preview orphan resource. */
function keyedRefs(
  previewKeys: Set<string>,
  refs: PreviewRef[],
  reason: "sweep:orphan-container" | "sweep:orphan-data-volume",
): OrphanDeletion[] {
  const seen = new Set<string>();
  const out: OrphanDeletion[] = [];
  for (const ref of refs) {
    const key = `${ref.slug}:${ref.prId}`;
    if (previewKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ reason, slug: ref.slug, prId: ref.prId });
  }
  return out;
}

export async function runSweepPass(ports: SweepPorts): Promise<SweepPassResult> {
  const [previewsResult, catalogResult, dataVolumesResult, containersResult] =
    await Promise.allSettled([
      ports.listPreviews(),
      ports.listCatalogDatabases(),
      ports.listDataVolumes(),
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
  const dataVolumes =
    dataVolumesResult.status === "fulfilled" ? dataVolumesResult.value : [];
  if (dataVolumesResult.status === "rejected") {
    ports.log?.(
      `sweep data volumes failed: ${String(dataVolumesResult.reason)}`,
    );
  }

  const nowMs = Date.now();
  const cutoff = nowMs - ports.ttlHours * 60 * 60 * 1000;
  const previewKeys = new Set<string>();
  const remainingPreviews: SweepPreview[] = [];
  const expiryDeletions: SweepDeletion[] = [];

  for (const preview of previews) {
    if (preview.status === "removed") continue;

    previewKeys.add(`${preview.slug}:${preview.prId}`);
    const governanceExpiry = planGovernanceExpiry(preview, nowMs);
    if (governanceExpiry) {
      expiryDeletions.push({
        reason: governanceExpiry,
        canonicalRepoId: preview.canonicalRepoId,
        prId: preview.prId,
        slug: preview.slug,
        dbName: preview.dbName,
        createdAt: preview.createdAt,
      });
    } else if (preview.createdAtMs !== null && preview.createdAtMs < cutoff) {
      expiryDeletions.push({
        reason: "sweep:ttl-expired",
        canonicalRepoId: preview.canonicalRepoId,
        prId: preview.prId,
        slug: preview.slug,
        dbName: preview.dbName,
        createdAt: preview.createdAt,
      });
    } else {
      remainingPreviews.push(preview);
    }
  }

  logOverCap(ports, previews);

  const orphanDeletions = planOrphans({
    previewKeys,
    catalog,
    containers,
    dataVolumes,
  });

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
      createdAt: preview.createdAt,
    });
  }

  const deletions = await dropSettled(
    ports,
    [...expiryDeletions, ...orphanDeletions, ...prNotOpenDeletions],
    (d) => `deleted (${d.reason})`,
  );

  return { forgeRepoFailures, deletions };
}

function activityBaseMs(preview: SweepPreview): number | null {
  if ((preview.lastActivityMs ?? null) !== null)
    return preview.lastActivityMs ?? null;
  return preview.createdAtMs;
}

/**
 * Governance expiry derived from the last activity plus the stored
 * per-preview durations. The stored expires_at is write-only for the read
 * surface: deriving here keeps a stale deadline from outliving a refresh.
 * The cheap activity signal is the last successful deploy (including
 * reseed/reset); see docs/previews.md. Returns the reason, or null to keep.
 */
export function planGovernanceExpiry(
  preview: SweepPreview,
  nowMs: number,
): "sweep:ttl-expired" | "sweep:idle-expired" | null {
  const base = activityBaseMs(preview);
  if (base === null) return null;
  const ttlDeadline =
    preview.ttlMs != null ? base + preview.ttlMs : null;
  const idleDeadline =
    preview.idleMs != null ? base + preview.idleMs : null;
  if (
    ttlDeadline !== null &&
    idleDeadline !== null &&
    nowMs >= ttlDeadline &&
    nowMs >= idleDeadline
  ) {
    return ttlDeadline <= idleDeadline
      ? "sweep:ttl-expired"
      : "sweep:idle-expired";
  }
  if (ttlDeadline !== null && nowMs >= ttlDeadline) {
    return "sweep:ttl-expired";
  }
  if (idleDeadline !== null && nowMs >= idleDeadline) {
    return "sweep:idle-expired";
  }
  return null;
}

function logOverCap(
  ports: SweepPorts,
  previews: SweepPreview[],
): void {
  const gov = ports.governance;
  if (!gov) return;
  const live = previews.filter((p) => p.status !== "removed");
  const status = governanceStatus(live, gov);
  const maxTotal = gov.maxPreviews;
  if (maxTotal !== null && status.total > maxTotal) {
    ports.log?.(
      `sweep over cap SPROUT_MAX_PREVIEWS (${status.total} > ${maxTotal})`,
    );
  }
  const perRepo = gov.maxPreviewsPerRepo;
  if (perRepo !== null) {
    for (const [repo, count] of status.byRepo) {
      if (count > perRepo) {
        ports.log?.(
          `sweep over cap SPROUT_MAX_PREVIEWS_PER_REPO ${repo} (${count} > ${perRepo})`,
        );
      }
    }
  }
  const perPreview = gov.previewMaxDbConnections;
  const ceiling = gov.postgresMaxConnections;
  const { projected, over } = status.connections;
  if (
    over &&
    projected !== null &&
    perPreview !== null &&
    ceiling !== null
  ) {
    ports.log?.(
      `sweep over connection budget (projected ${projected} > ceiling ${ceiling}; ` +
        `${status.total} previews x ${perPreview} per preview)`,
    );
  }
}
