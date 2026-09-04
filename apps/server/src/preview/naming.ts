const PREVIEW_DB_RE = /^prev_([a-zA-Z0-9]+)_pr(\d+)$/;
const PREVIEW_CONTAINER_RE = /^pb-([a-zA-Z0-9]+)-pr-(\d+)$/;

export function parsePreviewDatabaseName(
  datname: string,
): { slug: string; prId: number } | null {
  const match = PREVIEW_DB_RE.exec(datname);
  if (!match) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}

export function previewContainerName(slug: string, prId: number): string {
  return `pb-${slug}-pr-${prId}`;
}

export function parsePreviewContainerName(
  name: string,
): { slug: string; prId: number } | null {
  const match = PREVIEW_CONTAINER_RE.exec(name);
  if (!match) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
