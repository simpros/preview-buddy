import { and, eq, isNull } from "drizzle-orm";
import type { StateDb } from "../infrastructure/db/client.ts";
import { apiTokens } from "../infrastructure/db/schema.ts";
import { generateToken, hashToken } from "./tokens.ts";

export type BootstrapOptions = {
  adminToken?: string;
};

export async function bootstrapAdminToken(
  db: StateDb,
  options: BootstrapOptions = {},
): Promise<string | null> {
  if (options.adminToken) {
    const tokenHash = hashToken(options.adminToken);
    await db
      .insert(apiTokens)
      .values({ tokenHash, scope: "admin" })
      .onConflictDoNothing();
    return null;
  }

  const activeAdmin = await db
    .select({ tokenHash: apiTokens.tokenHash })
    .from(apiTokens)
    .where(and(eq(apiTokens.scope, "admin"), isNull(apiTokens.revokedAt)))
    .limit(1);

  if (activeAdmin.length > 0) return null;

  const raw = generateToken();
  await db.insert(apiTokens).values({
    tokenHash: hashToken(raw),
    scope: "admin",
  });
  return raw;
}
