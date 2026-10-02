import { Elysia } from "elysia";
import { authPlugin, requireAdmin, requireAuth } from "../auth/middleware.ts";
import type { PreviewAppOps } from "../app-deployment/ops.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import type { DashboardConfig } from "../config.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import type { GovernanceConfig } from "@sprout/preview-env";
import type { LifecycleDeps } from "../preview/lifecycle.ts";
import type { PreviewDataVolumes } from "../preview/data-volumes.ts";
import type { PreviewMaterializationCtx } from "../preview/runtime.ts";
import type { TelemetryDeployHook } from "../telemetry/contract.ts";
import type { TracesHandle } from "../telemetry/traces.ts";
import {
  createDeployToken,
  createDeployTokenBody,
  listTokens,
  revokeToken,
} from "./admin-tokens.ts";
import { getDashboard } from "./dashboard.ts";
import { deploy, deployBody, getPreview, previewQuery, teardown, teardownBody } from "./deploy.ts";
import { doctor, drop, dropBody, listPreviews } from "./introspection.ts";
import {
  accessQuery,
  getPreviewAccess,
  revokeBody,
  revokePreviewAccess,
  verifyPreviewAccess,
} from "./preview-access.ts";
import {
  getPreviewLogs,
  previewLogsParams,
  previewLogsQuery,
} from "./preview-logs.ts";

export type RouteDeps = {
  db: StateDb;
  previewDb: PreviewDbRouter;
  app: PreviewAppOps;
  dataVolumes: PreviewDataVolumes;
  materialization: PreviewMaterializationCtx;
  dashboard?: DashboardConfig;
  extraGitlabHosts?: ReadonlySet<string>;
  telemetry: TelemetryDeployHook;
  tracesPlugin?: TracesHandle["plugin"];
  governance: GovernanceConfig;
  /** Legacy creation-age bound (SPROUT_TTL_HOURS as ms), computed once in
   * loadConfig; routes never convert units themselves. */
  legacyTtlMs: number | null;
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
  const lifecycle: LifecycleDeps = {
    db: deps.db,
    previewDb: deps.previewDb,
    app: deps.app,
    dataVolumes: deps.dataVolumes,
    legacyTtlMs: deps.legacyTtlMs,
  };
  const deployDeps = {
    ...lifecycle,
    materialization: deps.materialization,
    telemetry: deps.telemetry,
    governance: deps.governance,
  };
  const mailboxUrl = deps.materialization.mail?.uiUrl;
  const accessDeps = {
    db: deps.db,
    ...(deps.materialization.previewAuth
      ? { previewAuth: deps.materialization.previewAuth }
      : {}),
  };
  const base = new Elysia();
  if (deps.tracesPlugin) {
    base.use(deps.tracesPlugin);
  }
  const app = base
    .get("/healthz", () => ({ ok: true }))
    .get("/v1/internal/preview-auth", verifyPreviewAccess(accessDeps));
  if (deps.dashboard?.enabled) {
    // .get registers on this instance; the narrowed return is dropped so the
    // Eden surface stays token-API-only (the page is HTML behind basic auth).
    app.get(
      "/dashboard",
      getDashboard({
        db: deps.db,
        dashboard: deps.dashboard,
        mailboxUrl,
        extraGitlabHosts: deps.extraGitlabHosts,
      }),
    );
  }
  return app.group("/v1", (v1) =>
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
      .get(
        "/previews",
        listPreviews(deps.db, mailboxUrl, deps.legacyTtlMs),
        {
          beforeHandle: requireAdmin,
        },
      )
      .get("/previews/access", getPreviewAccess(accessDeps), {
        query: accessQuery,
      })
      .post("/previews/access/revoke", revokePreviewAccess(accessDeps), {
        body: revokeBody,
      })
      .get("/previews/:id/logs", getPreviewLogs(lifecycle), {
        params: previewLogsParams,
        query: previewLogsQuery,
      })
      .get("/doctor", doctor(lifecycle), {
        beforeHandle: requireAdmin,
      })
      .post("/drop", drop(lifecycle), {
        beforeHandle: requireAdmin,
        body: dropBody,
      })
      .post("/deploy", deploy(deployDeps), { body: deployBody })
      .get("/preview", getPreview(lifecycle, mailboxUrl), {
        query: previewQuery,
      })
      .post("/teardown", teardown(lifecycle), { body: teardownBody })
      .all("/*", stubNotImplemented),
  );
}

export type SproutApi = ReturnType<typeof createRoutes>;
