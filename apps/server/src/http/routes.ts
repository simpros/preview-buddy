import { Elysia } from "elysia";
import { authPlugin, requireAdmin, requireAuth } from "../auth/middleware.ts";
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
    .get("/healthz", () => ({ ok: true }))
    .group("/v1", (v1) =>
      v1
        .use(authPlugin(deps.db))
        .onBeforeHandle(requireAuth)
        .group("/admin", (admin) =>
          admin
            .onBeforeHandle(requireAdmin)
            .get("/tokens", listTokens(deps.db))
            .post("/tokens", createDeployToken(deps.db), {
              body: createDeployTokenBody,
            })
            .delete("/tokens/:id", revokeToken(deps.db)),
        )
        .group("/previews", (g) =>
          g
            .onBeforeHandle(requireAdmin)
            .all("/", stubNotImplemented)
            .all("/*", stubNotImplemented),
        )
        .group("/doctor", (g) =>
          g
            .onBeforeHandle(requireAdmin)
            .all("/", stubNotImplemented)
            .all("/*", stubNotImplemented),
        )
        .all("/deploy", stubNotImplemented)
        .all("/teardown", stubNotImplemented)
        .all("/*", stubNotImplemented),
    );
}

export type PreviewBuddyApi = ReturnType<typeof createRoutes>;
