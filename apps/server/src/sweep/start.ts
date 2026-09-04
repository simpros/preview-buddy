import { createForgeClient } from "../forge/client.ts";
import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { createDockerRemover } from "./docker-remover.ts";
import { createLiveSweepPorts } from "./live-ports.ts";
import { createPostgresAdmin } from "./postgres-admin.ts";
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
      if (!deletion) {
        console.log(message);
        return;
      }
      switch (deletion.reason) {
        case "sweep:pr-not-open":
        case "sweep:ttl-expired":
          console.log(message, {
            reason: deletion.reason,
            prId: deletion.prId,
            slug: deletion.slug,
            dbName: deletion.dbName,
            canonicalRepoId: deletion.canonicalRepoId,
            containerId: deletion.containerId,
          });
          break;
        case "sweep:orphan-db":
          console.log(message, {
            reason: deletion.reason,
            prId: deletion.prId,
            slug: deletion.slug,
            dbName: deletion.dbName,
          });
          break;
        case "sweep:orphan-container":
          console.log(message, {
            reason: deletion.reason,
            prId: deletion.prId,
            slug: deletion.slug,
            containerId: deletion.containerId,
          });
          break;
        case "sweep:orphan-both":
          console.log(message, {
            reason: deletion.reason,
            prId: deletion.prId,
            slug: deletion.slug,
            dbName: deletion.dbName,
            containerId: deletion.containerId,
          });
          break;
      }
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
