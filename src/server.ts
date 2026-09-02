import { Elysia } from "elysia";
import type { Config } from "./config.ts";
import type { StateDb } from "./db.ts";

export type ServerDeps = {
  config: Config;
  state: StateDb;
};

function stubNotImplemented({
  set,
}: {
  set: { status?: number | string };
}) {
  set.status = 501;
  return { error: "not implemented" };
}

export function createServer(_deps: ServerDeps) {
  return new Elysia()
    .get("/healthz", () => ({ ok: true }))
    .group("/v1", (app) =>
      app.all("/", stubNotImplemented).all("/*", stubNotImplemented),
    );
}

export function startServer(deps: ServerDeps) {
  return createServer(deps).listen(deps.config.port);
}
