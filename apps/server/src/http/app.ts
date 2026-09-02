import type { Config } from "../config.ts";
import { createRoutes } from "./routes.ts";

export type ServerDeps = {
  config: Config;
};

export function startServer(deps: ServerDeps) {
  return createRoutes().listen(deps.config.port);
}
