export type PreviewEvent = {
  action: "opened" | "closed";
  prId: number;
  repo: string;
};

const IGNORED_GITHUB_ACTIONS = new Set(["synchronize"]);
const IGNORED_GITLAB_ACTIONS = new Set(["update"]);

export function normalizeGitHubPayload(payload: unknown): PreviewEvent | null {
  if (!payload || typeof payload !== "object") return null;

  const body = payload as Record<string, unknown>;
  if (body.action === undefined || typeof body.action !== "string") return null;
  if (IGNORED_GITHUB_ACTIONS.has(body.action)) return null;
  if (body.action !== "opened" && body.action !== "closed") return null;

  const pullRequest = body.pull_request;
  if (!pullRequest || typeof pullRequest !== "object") return null;
  const number = (pullRequest as Record<string, unknown>).number;
  if (typeof number !== "number") return null;

  const repository = body.repository;
  if (!repository || typeof repository !== "object") return null;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== "string") return null;

  return { action: body.action, prId: number, repo: fullName };
}

export function normalizeGitLabPayload(payload: unknown): PreviewEvent | null {
  if (!payload || typeof payload !== "object") return null;

  const body = payload as Record<string, unknown>;
  const attrs = body.object_attributes;
  if (!attrs || typeof attrs !== "object") return null;

  const objectAttributes = attrs as Record<string, unknown>;
  const action = objectAttributes.action;
  if (typeof action !== "string") return null;
  if (IGNORED_GITLAB_ACTIONS.has(action)) return null;

  let normalized: PreviewEvent["action"] | null = null;
  if (action === "open") normalized = "opened";
  else if (action === "close" || action === "merge") normalized = "closed";
  else return null;

  const iid = objectAttributes.iid;
  if (typeof iid !== "number") return null;

  const project = body.project;
  if (!project || typeof project !== "object") return null;
  const pathWithNamespace = (project as Record<string, unknown>)
    .path_with_namespace;
  if (typeof pathWithNamespace !== "string") return null;

  return { action: normalized, prId: iid, repo: pathWithNamespace };
}
