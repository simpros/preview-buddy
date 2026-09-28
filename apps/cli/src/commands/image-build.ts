import { defaultRunCommand, type CliContext } from "../context.ts";
import type { Result } from "../result.ts";

/** Docker tags cap at 128 chars; derived refs suffix the app tag. */
export const MAX_TAG_LENGTH = 128;

/** Scoped push credentials can only write under the project's own repository. */
export function splitTaggedImageRef(
  appImageRef: string,
  kind: string,
): Result<string> {
  const cut = appImageRef.lastIndexOf(":");
  if (cut <= 0 || cut === appImageRef.length - 1) {
    return {
      ok: false,
      error: `cannot derive ${kind} image ref from ${appImageRef}`,
    };
  }
  return { ok: true, value: appImageRef.slice(0, cut) };
}

/** Sibling tag under the app ref (`<app-ref>-<suffix>`), same repository path. */
export function deriveSiblingTagRef(
  appImageRef: string,
  suffix: string,
  kind: string,
): Result<string> {
  const repo = splitTaggedImageRef(appImageRef, kind);
  if (!repo.ok) return repo;
  const ref = `${appImageRef}-${suffix}`;
  if (ref.slice(ref.lastIndexOf(":") + 1).length > MAX_TAG_LENGTH) {
    return {
      ok: false,
      error: `derived ${kind} image ref exceeds ${MAX_TAG_LENGTH} chars: ${ref}`,
    };
  }
  return { ok: true, value: ref };
}

export async function buildAndPush(
  ctx: CliContext,
  label: string,
  dockerfile: string,
  ref: string,
): Promise<Result<true>> {
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const build = await run(
    ["docker", "build", "-f", dockerfile, "-t", ref, "."],
    { cwd: ctx.deps.cwd },
  );
  if (build.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image build failed (exit ${build.exitCode})`,
    };
  }
  const push = await run(["docker", "push", ref], { cwd: ctx.deps.cwd });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image push failed (exit ${push.exitCode})`,
    };
  }
  return { ok: true, value: true };
}
