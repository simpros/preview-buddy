import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const previews = sqliteTable(
  "previews",
  {
    canonicalRepoId: text("canonical_repo_id").notNull(),
    prId: integer("pr_id").notNull(),
    slug: text("slug").notNull(),
    dbName: text("db_name").notNull(),
    hostname: text("hostname").notNull(),
    appImage: text("app_image"),
    containerId: text("container_id"),
    status: text("status").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    seededAt: text("seeded_at"),
  },
  (table) => [
    primaryKey({ columns: [table.canonicalRepoId, table.prId] }),
  ],
);

export const repos = sqliteTable("repos", {
  canonicalId: text("canonical_id").primaryKey(),
  slug: text("slug").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const apiTokens = sqliteTable("api_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  scope: text("scope").notNull(),
  canonicalRepoId: text("canonical_repo_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  revokedAt: text("revoked_at"),
});
