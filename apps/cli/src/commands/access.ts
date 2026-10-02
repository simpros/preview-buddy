import type { ApiClient } from "@sprout/api-client";
import type { CliContext, CliIo } from "../context.ts";
import { fail, resolveRepo } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import type { Result } from "../result.ts";

export type AccessResponse =
  | {
      ok: true;
      auth: "basic";
      username: string;
      password: string;
      hostname: string;
    }
  | {
      ok: true;
      auth: "link";
      url: string;
      expires_at: string;
      hostname: string;
    }
  | { ok: true; auth: "none"; hostname: string; preview_url: string };

export type RevokeResponse = {
  ok: true;
  auth: "basic" | "link";
  revoked: true;
  relabel_required?: true;
};

export function formatAccess(data: AccessResponse): string {
  if (data.auth === "basic") {
    return [
      `Preview is gated with basic auth:`,
      `URL: https://${data.hostname}`,
      `Username: ${data.username}`,
      `Password: ${data.password}`,
    ].join("\n");
  }
  if (data.auth === "link") {
    return [
      `Shareable link (expires ${data.expires_at}):`,
      data.url,
    ].join("\n");
  }
  return [
    `Preview has no access gate (preview.auth is none):`,
    data.preview_url,
  ].join("\n");
}

export function formatRevoked(data: RevokeResponse): string {
  if (data.auth === "basic") {
    return [
      `Credential rotated. Traefik embeds the basic-auth hash in the preview labels,`,
      `so the new password applies on the next deploy.`,
    ].join("\n");
  }
  return `Outstanding links revoked with no redeploy.`;
}

export async function fetchPreviewAccess(
  client: ApiClient,
  opts: { repo: string; prId: number; expires?: string },
): Promise<Result<AccessResponse>> {
  const response = await client.v1.previews.access.get({
    query: {
      canonical_repo_id: opts.repo,
      pr_id: String(opts.prId),
      ...(opts.expires !== undefined ? { expires: opts.expires } : {}),
    },
  });
  const result = readEden<AccessResponse>(response);
  if (!result.ok) return { ok: false, error: result.message };
  const data = result.data;
  if (
    data.auth === "link" &&
    (data.expires_at as unknown) instanceof Date
  ) {
    return {
      ok: true,
      value: {
        ...data,
        expires_at: (data.expires_at as unknown as Date).toISOString(),
      },
    };
  }
  return { ok: true, value: data };
}

export async function revokePreviewAccess(
  client: ApiClient,
  opts: { repo: string; prId: number },
): Promise<Result<RevokeResponse>> {
  const response = await client.v1.previews.access.revoke.post({
    canonical_repo_id: opts.repo,
    pr_id: opts.prId,
  });
  const result = readEden<RevokeResponse>(response);
  if (!result.ok) return { ok: false, error: result.message };
  return { ok: true, value: result.data };
}

export function printAccess(io: CliIo, data: AccessResponse): void {
  io.stdout(formatAccess(data));
}

export async function runAccess(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, ["--repo", "--expires", "--revoke"]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);

  const [prRaw, ...extra] = flags.value.rest;
  if (!prRaw || extra.length > 0) {
    return fail(
      ctx.deps.io,
      "usage: sprout access <pr_id> [--expires 7d] [--revoke] [--repo URL]",
    );
  }
  const prId = Number(prRaw);
  if (!Number.isInteger(prId) || prId <= 0) {
    return fail(ctx.deps.io, "pr_id must be a positive integer");
  }
  if (flags.value.revoke && flags.value.expires !== undefined) {
    return fail(ctx.deps.io, "--revoke cannot be combined with --expires");
  }

  const repo = resolveRepo(ctx.deps, flags.value.repo);
  if (!repo.ok) return fail(ctx.deps.io, repo.error);

  if (flags.value.revoke) {
    const revoked = await revokePreviewAccess(ctx.client, {
      repo: repo.value,
      prId,
    });
    if (!revoked.ok) return fail(ctx.deps.io, revoked.error);
    ctx.deps.io.stdout(formatRevoked(revoked.value));
    return 0;
  }

  const access = await fetchPreviewAccess(ctx.client, {
    repo: repo.value,
    prId,
    ...(flags.value.expires !== undefined
      ? { expires: flags.value.expires }
      : {}),
  });
  if (!access.ok) return fail(ctx.deps.io, access.error);

  printAccess(ctx.deps.io, access.value);
  return 0;
}
