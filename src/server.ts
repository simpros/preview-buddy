import { Elysia } from "elysia";
import type { Config } from "./config.ts";

export type ServerDeps = {
  config: Config;
};

export function createServer(_deps: ServerDeps) {
  return new Elysia()
    .get("/healthz", () => ({ ok: true }))
    .group("/v1", (app) =>
      app.all("/*", ({ set }) => {
        set.status = 501;
        return { error: "not implemented" };
      }),
    );
}

export function startServer(deps: ServerDeps) {
  return createServer(deps).listen(deps.config.port);
}
