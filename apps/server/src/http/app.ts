import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewDataVolumes } from "../preview/data-volumes.ts";
import type { PreviewMaterializationCtx } from "../preview/runtime.ts";
import { NO_TELEMETRY, type TelemetryDeployHook } from "../telemetry/contract.ts";
import type { TracesHandle } from "../telemetry/traces.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  dataVolumes: PreviewDataVolumes;
  materialization: PreviewMaterializationCtx;
  telemetry?: TelemetryDeployHook;
  tracesPlugin?: TracesHandle["plugin"];
};

export function startServer(deps: ServerDeps) {
  return createRoutes({
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    dataVolumes: deps.dataVolumes,
    materialization: deps.materialization,
    dashboard: deps.config.dashboard,
    extraGitlabHosts: deps.config.extraGitlabHosts,
    telemetry: deps.telemetry ?? NO_TELEMETRY,
    ...(deps.tracesPlugin ? { tracesPlugin: deps.tracesPlugin } : {}),
    governance: {
      previewTtlMs: deps.config.previewTtlMs,
      previewIdleMs: deps.config.previewIdleMs,
      maxPreviewsPerRepo: deps.config.maxPreviewsPerRepo,
      maxPreviews: deps.config.maxPreviews,
      previewMaxDbConnections: deps.config.previewMaxDbConnections,
      postgresMaxConnections: deps.config.postgresMaxConnections,
    },
  }).listen(deps.config.port);
}
