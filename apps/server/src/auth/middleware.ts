import { Elysia } from "elysia";
import type { StateDb } from "../infrastructure/db/client.ts";
import { findActive, type AuthContext } from "./store.ts";
import { parseBearer } from "./tokens.ts";

export type { AuthContext };

function unauthorized(set: { status?: number | string }) {
  set.status = 401;
  return { error: "unauthorized" };
}

function forbidden(set: { status?: number | string }) {
  set.status = 403;
  return { error: "forbidden" };
}

type AuthGuardContext = {
  auth: AuthContext | null;
  set: { status?: number | string };
};

export function requireAuth({ auth, set }: AuthGuardContext) {
  if (!auth) return unauthorized(set);
}

export function requireAdmin({ auth, set }: AuthGuardContext) {
  if (!auth) return unauthorized(set);
  if (auth.scope !== "admin") return forbidden(set);
}

export function authPlugin(db: StateDb) {
  return new Elysia({ name: "auth" }).derive(
    { as: "scoped" },
    async ({ request }): Promise<{ auth: AuthContext | null }> => {
      const raw = parseBearer(request.headers.get("authorization"));
      if (!raw) return { auth: null };
      return { auth: await findActive(db, raw) };
    },
  );
}
