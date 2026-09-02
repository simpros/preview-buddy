import { treaty } from "@elysia/eden";
import type { PreviewBuddyApi } from "../../../apps/server/src/http/app.ts";

export type { PreviewBuddyApi } from "../../../apps/server/src/http/app.ts";

export type ApiClient = ReturnType<typeof treaty<PreviewBuddyApi>>;

export type ApiClientOptions = {
  headers?: HeadersInit;
};

export const createApiClient = (
  baseUrl: string,
  options: ApiClientOptions = {},
) =>
  treaty<PreviewBuddyApi>(baseUrl, {
    headers: options.headers,
  });
