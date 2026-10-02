import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewDataVolumes } from "../preview/data-volumes.ts";
import type { PreviewMaterializationCtx } from "../preview/runtime.ts";
import type { TelemetryDeployHook } from "../telemetry/reporter.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  dataVolumes: PreviewDataVolumes;
  materialization: PreviewMaterializationCtx;
  telemetry?: TelemetryDeployHook;
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
    ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
  }).listen(deps.config.port);
}
