export function previewDbName(slug: string, prId: number): string {
  return `sprout_${slug}_pr${prId}`;
}
