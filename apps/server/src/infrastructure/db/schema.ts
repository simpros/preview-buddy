import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const utcIsoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const previews = sqliteTable(
  "previews",
  {
    canonicalRepoId: text("canonical_repo_id").notNull(),
    prId: integer("pr_id").notNull(),
    slug: text("slug").notNull(),
    dbName: text("db_name"),
    dbProvider: text("db_provider").notNull().default("postgres"),
    hostname: text("hostname").notNull(),
    appImage: text("app_image"),
    containerId: text("container_id"),
    status: text("status").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(utcIsoNow),
    updatedAt: text("updated_at")
      .notNull()
      .default(utcIsoNow),
    seededAt: text("seeded_at"),
    seededSeedImage: text("seeded_seed_image"),
    lastError: text("last_error"),
    lastErrorDetail: text("last_error_detail"),
    failureFamily: text("failure_family"),
    bringUpPlan: text("bring_up_plan"),
    seedLog: text("seed_log"),
    mailFrom: text("mail_from"),
    authMode: text("auth_mode").notNull().default("none"),
    authSecret: text("auth_secret"),
    authBasicUser: text("auth_basic_user"),
    authBasicPassword: text("auth_basic_password"),
    lastActivityAt: text("last_activity_at"),
    expiryReason: text("expiry_reason"),
    ttlMs: integer("ttl_ms"),
    idleMs: integer("idle_ms"),
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
    .default(utcIsoNow),
});

export const apiTokens = sqliteTable("api_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  scope: text("scope").notNull(),
  canonicalRepoId: text("canonical_repo_id"),
  createdAt: text("created_at")
    .notNull()
    .default(utcIsoNow),
  revokedAt: text("revoked_at"),
});
