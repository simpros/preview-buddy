import { configSummary, loadConfig } from "./config.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { runMigrations } from "./scripts/migrate.ts";

const config = loadConfig();
console.log("preview-buddy starting", configSummary(config));

const { db, sql } = connectState();
await runMigrations(sql);
startServer({ config, db });
