import { bindPreviewOps } from "./app-deployment/ops.ts";
import { bootstrapAdminToken } from "./auth/bootstrap-admin.ts";
import {
  configSummary,
  loadConfig,
} from "./config.ts";
import { createDockerEngineClient } from "./docker/engine.ts";
import { startServer } from "./http/app.ts";
import { connectState } from "./infrastructure/db/client.ts";
import { createPostgresPreviewDb } from "./preview-db/postgres.ts";
import { createRoutingPreviewDb } from "./preview-db/routing.ts";
import { createSqlitePreviewDb } from "./preview-db/sqlite.ts";
import { buildMaterializationCtx } from "./preview/runtime.ts";
import { bindPreviewDataVolumes } from "./preview/data-volumes.ts";
import { runMigrations } from "./scripts/migrate.ts";
import { startGatewaySweep } from "./sweep/start.ts";
import { createTelemetryReporter } from "./telemetry/reporter.ts";
import { createTraces } from "./telemetry/traces.ts";

const config = loadConfig();
console.log("sprout starting", configSummary(config));

const traces = createTraces(config);

const { sql, db } = connectState();
await runMigrations(sql);

await bootstrapAdminToken(db, config.adminToken);

const docker = createDockerEngineClient({
  registryPullAuth: config.registryPullAuth,
});

// Only this wiring decides which database adapters exist; per-deploy
// dispatch lives in the PreviewDb / plan-resolution seam modules.
const postgresDb = config.postgres
  ? createPostgresPreviewDb({
      url: config.postgres.url,
      previewRole: config.postgres.user,
      previewPassword: config.postgres.password,
    })
  : undefined;
if (postgresDb) await postgresDb.ensurePreviewRole();

const previewDb = createRoutingPreviewDb({
  postgres: postgresDb,
  sqlite: createSqlitePreviewDb(docker),
});

// The single materialization input every deploy resolves its plan from.
// Postgres presence lives only here; the deploy gate reads ctx.postgres.
// Mail presence lives only here too; it never provisions, only injects.
const materialization = buildMaterializationCtx(config);

const app = bindPreviewOps({
  docker,
  previewPortDefault: config.previewPortDefault,
  seedTimeoutMs: config.seedTimeout * 1000,
});
const dataVolumes = bindPreviewDataVolumes(docker);

const telemetry = createTelemetryReporter({ config, db });
console.log(`telemetry ${telemetry.describe()}`);
telemetry.startHeartbeat();

startServer({
  config,
  db,
  previewDb,
  app,
  dataVolumes,
  materialization,
  telemetry,
  ...(traces.plugin ? { tracesPlugin: traces.plugin } : {}),
});
startGatewaySweep({ config, db, previewDb, app, dataVolumes });
console.log(
  `sweep scheduled (${config.sweepCron}): first pass on the next boundary`,
);
