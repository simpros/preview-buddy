import { ensureAdminToken } from "./auth/store.ts";
import { configSummary, loadConfig } from "./config.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { createPostgresPreviewDb } from "./preview-db/postgres.ts";
import { createDockerRemover } from "./preview/containers.ts";
import { runMigrations } from "./scripts/migrate.ts";
import { startGatewaySweep } from "./sweep/start.ts";

const config = loadConfig();
console.log("preview-buddy starting", configSummary(config));

const { sql, db } = connectState();
await runMigrations(sql);

const generatedAdminToken = await ensureAdminToken(db, config.adminToken);
if (generatedAdminToken) {
  console.warn(
    "PB_ADMIN_TOKEN not set; generated bootstrap admin token (store securely):",
    generatedAdminToken,
  );
}

const previewDb = createPostgresPreviewDb({
  url: config.previewPostgresUrl,
  previewRole: config.previewPgUser,
});
const containers = createDockerRemover();

startServer({ config, db, previewDb, containers });
startGatewaySweep({ config, db, previewDb, containers });
console.log(
  `sweep scheduled: first pass in ${config.sweepMinutes}m, then every ${config.sweepMinutes}m`,
);
