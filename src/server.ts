import { Elysia } from "elysia";
import type { Config } from "./config.ts";
import {
  clearPreviewState,
  connectAdmin,
  createDatabase,
  dropDatabase,
  ensureRole,
  grantDatabaseAccess,
  recordPreviewState,
} from "./db.ts";
import { normalizeGitHubPayload, normalizeGitLabPayload } from "./events.ts";
import { verifyGitHubSignature, verifyGitLabToken } from "./verify.ts";

export type ServerDeps = {
  config: Config;
  connect?: typeof connectAdmin;
};

export function createServer(deps: ServerDeps) {
  const connect = deps.connect ?? connectAdmin;
  const { config } = deps;

  return new Elysia()
    .get("/healthz", () => ({ ok: true }))
    .post("/webhooks/github", async ({ request, set }) => {
      const rawBody = await request.text();
      const signature = request.headers.get("x-hub-signature-256");

      if (
        !verifyGitHubSignature(
          rawBody,
          signature,
          config.githubWebhookSecret,
        )
      ) {
        set.status = 400;
        return { error: "invalid signature" };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        set.status = 422;
        return { error: "unparsable payload" };
      }

      const event = normalizeGitHubPayload(payload);
      if (!event) {
        return { ignored: true };
      }

      return handleEvent(connect, config, event);
    })
    .post("/webhooks/gitlab", async ({ request, set }) => {
      const rawBody = await request.text();
      const token = request.headers.get("x-gitlab-token");

      if (!verifyGitLabToken(token, config.gitlabWebhookSecret)) {
        set.status = 400;
        return { error: "invalid token" };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        set.status = 422;
        return { error: "unparsable payload" };
      }

      const event = normalizeGitLabPayload(payload);
      if (!event) {
        return { ignored: true };
      }

      return handleEvent(connect, config, event);
    });
}

async function handleEvent(
  connect: typeof connectAdmin,
  config: Config,
  event: { action: "opened" | "closed"; prId: number; repo: string },
) {
  const sql = connect(config.pbDatabaseUrl);
  try {
    if (event.action === "opened") {
      const dbName = await createDatabase(sql, config.pbDbPrefix, event.prId);
      await ensureRole(sql);
      await grantDatabaseAccess(sql, dbName);
      await recordPreviewState(sql, event.prId, event.repo);
      return { action: "opened", prId: event.prId, database: dbName };
    }

    await dropDatabase(sql, config.pbDbPrefix, event.prId);
    await clearPreviewState(sql, event.prId, event.repo);
    return { action: "closed", prId: event.prId };
  } finally {
    await sql.close();
  }
}

export function startServer(deps: ServerDeps) {
  return createServer(deps).listen(configPort(deps.config));
}

function configPort(config: Config): number {
  return config.pbPort;
}
