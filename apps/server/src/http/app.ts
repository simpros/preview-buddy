import type { Config } from "../config.ts";
import type { PreviewDocker } from "../docker/port.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
  previewDb: PreviewDb;
  docker: PreviewDocker;
};

export function startServer(deps: ServerDeps) {
  return createRoutes({
    db: deps.db,
    previewDb: deps.previewDb,
    docker: deps.docker,
    appDeploy: {
      pg: {
        host: deps.config.previewPgHost,
        port: deps.config.previewPgPort,
        user: deps.config.previewPgUser,
        password: deps.config.previewPgPassword,
      },
      networks: {
        traefik: deps.config.traefikNetwork,
        postgres: deps.config.postgresNetwork,
      },
      previewPortDefault: deps.config.previewPortDefault,
    },
  }).listen(deps.config.port);
}
