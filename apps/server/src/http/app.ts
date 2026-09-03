import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
};

export function startServer(deps: ServerDeps) {
  return createRoutes({ db: deps.db }).listen(deps.config.port);
}
