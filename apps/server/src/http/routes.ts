import { Elysia } from "elysia";
import {
  authPlugin,
  requireAdmin,
  requireAuth,
  requireDeployOrAdmin,
} from "../auth/middleware.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import {
  createDeployToken,
  createDeployTokenBody,
  listTokens,
  revokeToken,
} from "./admin-tokens.ts";

export type RouteDeps = {
  db: StateDb;
};

function stubNotImplemented({
  set,
}: {
  set: { status?: number | string };
}) {
  set.status = 501;
  return { error: "not implemented" };
}

export function createRoutes(deps: RouteDeps) {
  return new Elysia()
    .use(authPlugin(deps.db))
    .get("/healthz", () => ({ ok: true }))
    .group("/v1/admin", (admin) =>
      admin
        .onBeforeHandle(requireAdmin)
        .get("/tokens", listTokens(deps.db))
        .post("/tokens", createDeployToken(deps.db), {
          body: createDeployTokenBody,
        })
        .delete("/tokens/:id", revokeToken(deps.db)),
    )
    .group("/v1", (app) =>
      app
        .onBeforeHandle(requireDeployOrAdmin)
        .all("/deploy", stubNotImplemented)
        .all("/teardown", stubNotImplemented),
    )
    .group("/v1", (app) =>
      app
        .onBeforeHandle(requireAdmin)
        .all("/previews", stubNotImplemented)
        .all("/doctor", stubNotImplemented),
    )
    .group("/v1", (app) =>
      app.onBeforeHandle(requireAuth).all("/", stubNotImplemented),
    )
    .group("/v1", (app) =>
      app.onBeforeHandle(requireAuth).all("/*", stubNotImplemented),
    );
}

export type PreviewBuddyApi = ReturnType<typeof createRoutes>;
