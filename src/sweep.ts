import type { AdminDb } from "./db.ts";
import {
  clearPreviewState,
  dropDatabase,
  ensureStateTable,
  listDatabases,
  prIdFromDatabaseName,
} from "./db.ts";

export type OpenPrProvider = () => Promise<number[]>;

export async function sweep(
  sql: AdminDb,
  prefix: string,
  ttlHours: number,
  getOpenPrIds: OpenPrProvider,
): Promise<{ dropped: string[] }> {
  await ensureStateTable(sql);
  const openSet = new Set(await getOpenPrIds());
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  const dropped: string[] = [];

  const rows = await sql<
    { pr_id: number; repo: string; created_at: Date }[]
  >`SELECT pr_id, repo, created_at FROM pb_state`;

  for (const row of rows) {
    const expired = new Date(row.created_at).getTime() < cutoff;
    const notOpen = !openSet.has(row.pr_id);
    if (!expired && !notOpen) continue;

    await dropDatabase(sql, prefix, row.pr_id);
    await clearPreviewState(sql, row.pr_id, row.repo);
    dropped.push(`${prefix}${row.pr_id}`);
  }

  for (const datname of await listDatabases(sql, prefix)) {
    const prId = prIdFromDatabaseName(prefix, datname);
    if (prId === null || openSet.has(prId)) continue;
    if (dropped.includes(datname)) continue;

    await dropDatabase(sql, prefix, prId);
    dropped.push(datname);
  }

  return { dropped };
}

/** MVP stub: real implementation will query GitHub/GitLab for open PRs. */
export async function stubOpenPrIds(): Promise<number[]> {
  return [];
}
