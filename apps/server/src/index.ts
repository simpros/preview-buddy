import { bootstrapAdminToken } from "./auth/bootstrap.ts";
import { configSummary, loadConfig } from "./config.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { runMigrations } from "./scripts/migrate.ts";

const config = loadConfig();
console.log("preview-buddy starting", configSummary(config));

const { sql, db } = connectState();
await runMigrations(sql);

const generatedAdminToken = await bootstrapAdminToken(db, {
  adminToken: config.adminToken,
});
if (generatedAdminToken) {
  console.warn(
    "PB_ADMIN_TOKEN not set; generated bootstrap admin token (store securely):",
    generatedAdminToken,
  );
}

startServer({ config, db });
