import type { PreviewAppOps } from "../app-deployment/ops.ts";
import { createForgeClient } from "../forge/client.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { PreviewDataVolumes } from "../preview/data-volumes.ts";
import { createLiveSweepPorts } from "./live-ports.ts";
import { runSweepPass } from "./reconcile.ts";
import { startSweepTimer, type SweepTimerHandle } from "./timer.ts";

export function startGatewaySweep(deps: {
  config: Config;
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  dataVolumes: PreviewDataVolumes;
}): SweepTimerHandle {
  const forge = createForgeClient({
    githubToken: deps.config.githubToken,
    gitlabToken: deps.config.gitlabToken,
    extraGitlabHosts: deps.config.extraGitlabHosts,
  });
  const ports = createLiveSweepPorts({
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    dataVolumes: deps.dataVolumes,
    forge,
    ttlHours: deps.config.ttlHours,
    governance: deps.config,
    log: (message, deletion) => {
      if (deletion) console.log(message, deletion);
      else console.log(message);
    },
  });

  return startSweepTimer({
    schedule: deps.config.sweepCron,
    runPass: async () => {
      await runSweepPass(ports);
    },
    onError: (error) => {
      console.error("sweep pass failed", error);
    },
  });
}