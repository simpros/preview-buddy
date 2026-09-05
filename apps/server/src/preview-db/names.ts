const SLUG_RE = /^[a-z][a-z0-9]*$/;
/** Single grammar for preview DB names — also used by the Postgres DDL guard. */
const PREVIEW_DB_NAME_RE = /^prev_[a-z][a-z0-9]*_pr[1-9][0-9]*$/;

export type IdentifierError = "invalid_slug" | "invalid_pr_id";

export function validateSlug(slug: string): IdentifierError | null {
  if (!SLUG_RE.test(slug)) return "invalid_slug";
  return null;
}

export function validatePrId(prId: number): IdentifierError | null {
  if (!Number.isInteger(prId) || prId <= 0) return "invalid_pr_id";
  return null;
}

/** Builds `prev_<slug>_pr<id>` after identifiers are validated. */
export function previewDbName(slug: string, prId: number): string {
  return `prev_${slug}_pr${prId}`;
}

export function isPreviewDbName(dbName: string): boolean {
  return PREVIEW_DB_NAME_RE.test(dbName);
}

export function assertPreviewDbName(dbName: string): void {
  if (!isPreviewDbName(dbName)) {
    throw new Error(`refusing unsafe preview database name: ${dbName}`);
  }
}
