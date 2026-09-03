import type { PreviewDb } from "./port.ts";

export type FakePreviewDb = PreviewDb & {
  created: string[];
  dropped: string[];
};

export function createFakePreviewDb(): FakePreviewDb {
  const created: string[] = [];
  const dropped: string[] = [];
  return {
    created,
    dropped,
    async createDatabase(dbName) {
      created.push(dbName);
    },
    async dropDatabase(dbName) {
      dropped.push(dbName);
    },
  };
}
