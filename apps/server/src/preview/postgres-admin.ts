import { SQL } from "bun";
import { parsePreviewDatabaseName, quoteIdent } from "./naming.ts";

export type CatalogDatabase = {
  dbName: string;
  slug: string;
  prId: number;
};

export type PostgresAdmin = {
  listPreviewDatabases: () => Promise<CatalogDatabase[]>;
  dropDatabase: (dbName: string) => Promise<void>;
};

export function createPostgresAdmin(databaseUrl: string): PostgresAdmin {
  const sql = new SQL(databaseUrl);
  return {
    async listPreviewDatabases() {
      const rows = await sql<{ datname: string }[]>`
        SELECT datname FROM pg_database
        WHERE datname LIKE 'prev_%'
      `;
      const out: CatalogDatabase[] = [];
      for (const row of rows) {
        const parsed = parsePreviewDatabaseName(row.datname);
        if (!parsed) continue;
        out.push({
          dbName: row.datname,
          slug: parsed.slug,
          prId: parsed.prId,
        });
      }
      return out;
    },
    async dropDatabase(dbName: string) {
      if (!parsePreviewDatabaseName(dbName)) {
        throw new Error(`Refusing to drop non-preview database: ${dbName}`);
      }
      await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
    },
  };
}
