import { treaty } from "@elysia/eden";
import type { PreviewBuddyApi } from "@preview-buddy/server/api-type";

export type { PreviewBuddyApi } from "@preview-buddy/server/api-type";

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
