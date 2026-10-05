/** App container per preview: the single name both the gateway and the
 * acceptance harness address. */
export function previewContainerName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}`;
}

/** -sqlite suffix stays outside the container and Postgres catalogs. */
export function sqliteVolumeName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-sqlite`;
}

/** Per-preview app-data volume: one named volume per `preview.volumes` entry. */
export function dataVolumeName(slug: string, prId: number, index: number): string {
  return `sprout-${slug}-pr-${prId}-data-${index}`;
}

const SQLITE_VOLUME_RE = /^sprout-([a-zA-Z0-9]+)-pr-(\d+)-sqlite$/;

export function parseSqliteVolumeName(
  name: string,
): { slug: string; prId: number } | null {
  const match = SQLITE_VOLUME_RE.exec(name);
  if (!match) return null;
  const prId = Number(match[2]);
  if (!Number.isInteger(prId) || prId <= 0) return null;
  return { slug: match[1]!, prId };
}

const DATA_VOLUME_RE = /^sprout-([a-zA-Z0-9]+)-pr-(\d+)-data-(\d+)$/;

/** Canonical app-data volume ref: the daemon name plus its preview owner. */
export type DataVolumeRef = {
  name: string;
  slug: string;
  prId: number;
};

export function parseDataVolumeName(name: string): Omit<DataVolumeRef, "name"> | null {
  const match = DATA_VOLUME_RE.exec(name);
  if (!match) return null;
  const prId = Number(match[2]);
  const index = Number(match[3]);
  if (!Number.isInteger(prId) || prId <= 0) return null;
  if (!Number.isInteger(index) || index < 0) return null;
  return { slug: match[1]!, prId };
}
