/** Unambiguous UTC instant: ends with Z or numeric ±HH:MM offset. */
const UNAMBIGUOUS_UTC_INSTANT = /Z|[+-]\d{2}:\d{2}$/;

/** Fail-closed: only Z / ±HH:MM forms become a TTL instant; else null. */
export function parseUnambiguousUtcMs(createdAt: string): number | null {
  if (!UNAMBIGUOUS_UTC_INSTANT.test(createdAt)) return null;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}
