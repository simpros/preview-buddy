import { Elysia } from "elysia";
import type { Config } from "./config.ts";
import type { StateDb } from "./db.ts";

export type ServerDeps = {
  config: Config;
  state: StateDb;
};

export function createServer(deps: ServerDeps) {
  return new Elysia()
    .derive(() => ({ stateDb: deps.state }))
    .get("/healthz", () => ({ ok: true }))
    .group("/v1", (app) =>
      app
        .all("/", ({ set }) => {
          set.status = 501;
          return { error: "not implemented" };
        })
        .all("/*", ({ set }) => {
          set.status = 501;
          return { error: "not implemented" };
        }),
    );
}

export function startServer(deps: ServerDeps) {
  return createServer(deps).listen(deps.config.port);
}
