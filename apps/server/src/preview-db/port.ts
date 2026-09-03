/** Admin operations on the shared Postgres instance for preview databases. */
export type PreviewDb = {
  createDatabase(dbName: string): Promise<void>;
  dropDatabase(dbName: string): Promise<void>;
};
