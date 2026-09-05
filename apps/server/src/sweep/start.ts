import { createForgeClient } from "../forge/client.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { createDockerRemover } from "../preview/containers.ts";
import { createPostgresAdmin } from "../preview/postgres-admin.ts";
import { createLiveSweepPorts } from "./live-ports.ts";
import { runSweepPass } from "./reconcile.ts";
import { startSweepTimer, type SweepTimerHandle } from "./timer.ts";

export function startGatewaySweep(deps: {
  config: Config;
  db: StateDb;
}): SweepTimerHandle {
  const forge = createForgeClient({
    forge: deps.config.forge,
    token: deps.config.forgeToken,
  });
  const postgres = createPostgresAdmin(deps.config.previewPostgresUrl);
  const containers = createDockerRemover();
  const ports = createLiveSweepPorts({
    db: deps.db,
    postgres,
    containers,
    forge,
    ttlHours: deps.config.ttlHours,
    log: (message, deletion) => {
      if (deletion) console.log(message, deletion);
      else console.log(message);
    },
  });

  const intervalMs = deps.config.sweepMinutes * 60 * 1000;
  return startSweepTimer({
    intervalMs,
    runPass: async () => {
      await runSweepPass(ports);
    },
    onError: (error) => {
      console.error("sweep pass failed", error);
    },
  });
}
