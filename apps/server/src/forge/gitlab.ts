import { finiteIdsFromArray } from "./parse.ts";
import { forgeApiError, type FetchLike, type ForgeClient } from "./types.ts";

export type GitLabForgeOptions = {
  token: string;
  fetch?: FetchLike;
  apiBase?: string;
};

const PER_PAGE = 100;

/** Parse https://gitlab.com/group/project → path (group/project). */
export function parseGitLabProjectPath(canonicalRepoId: string): string {
  let url: URL;
  try {
    url = new URL(canonicalRepoId);
  } catch {
    throw forgeApiError(
      `Invalid GitLab canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  if (url.hostname !== "gitlab.com") {
    throw forgeApiError(`Not a gitlab.com repo id: ${canonicalRepoId}`, 400);
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path || !path.includes("/")) {
    throw forgeApiError(
      `Invalid GitLab canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  return path;
}

export function createGitLabForge(options: GitLabForgeOptions): ForgeClient {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://gitlab.com/api/v4";

  return {
    async listOpenPrIds(canonicalRepoId: string): Promise<number[]> {
      const projectPath = parseGitLabProjectPath(canonicalRepoId);
      const encoded = encodeURIComponent(projectPath);
      const ids: number[] = [];
      let page = 1;

      while (true) {
        const url = `${apiBase}/projects/${encoded}/merge_requests?state=opened&per_page=${PER_PAGE}&page=${page}`;
        const res = await fetchImpl(url, {
          headers: {
            "private-token": options.token,
          },
        });
        if (!res.ok) {
          throw forgeApiError(
            `GitLab open-MR list failed: ${res.status}`,
            res.status,
          );
        }
        const pageIds = finiteIdsFromArray(await res.json(), "iid");
        ids.push(...pageIds);
        if (pageIds.length < PER_PAGE) break;
        page += 1;
      }

      return ids;
    },
  };
}
