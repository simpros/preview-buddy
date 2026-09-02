import type { Config } from "../config.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
  db: StateDb;
};

export type { PreviewBuddyApi } from "./routes.ts";

export const createApp = (_deps: ServerDeps) => createRoutes();

export function startServer(deps: ServerDeps) {
  return createApp(deps).listen(deps.config.port);
}
