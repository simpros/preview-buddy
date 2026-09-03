import { Elysia } from "elysia";

function stubNotImplemented({
  set,
}: {
  set: { status?: number | string };
}) {
  set.status = 501;
  return { error: "not implemented" };
}

export function createRoutes() {
  return new Elysia()
    .get("/healthz", () => ({ ok: true }))
    .group("/v1", (app) =>
      app.all("/", stubNotImplemented).all("/*", stubNotImplemented),
    );
}

export type PreviewBuddyApi = ReturnType<typeof createRoutes>;
