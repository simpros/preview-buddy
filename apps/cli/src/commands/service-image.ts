import type { CliContext } from "../context.ts";
import type { Result } from "../result.ts";
import { parseServiceFlag, type ServiceSelection } from "../services.ts";
import type { SproutYaml } from "../yaml.ts";
import { buildAndPush, deriveSiblingTagRef } from "./image-build.ts";

export function resolveServiceImageRef(
  appImageRef: string,
  serviceName: string,
): Result<string> {
  return deriveSiblingTagRef(appImageRef, serviceName, "service");
}

export function serviceFlagOverrides(flags: string[]): Result<Set<string>> {
  const out = new Set<string>();
  for (const raw of flags) {
    const parsed = parseServiceFlag(raw);
    if (!parsed.ok) return parsed;
    out.add(parsed.value.name);
  }
  return { ok: true, value: out };
}

/** A target carries its own Dockerfile so the build loop never re-derives
 * what the resolver already guaranteed. */
export type ServiceImageTarget = { dockerfile: string; ref: string };

export type ServiceImageTargets = Map<string, ServiceImageTarget>;

export function resolveServiceImageTargets(
  yaml: SproutYaml,
  appImageRef: string,
  overrides: Set<string>,
): Result<ServiceImageTargets> {
  const targets: ServiceImageTargets = new Map();
  for (const svc of yaml.preview.services ?? []) {
    if (svc.dockerfile === undefined) continue;
    if (overrides.has(svc.name)) continue;
    const ref = resolveServiceImageRef(appImageRef, svc.name);
    if (!ref.ok) return ref;
    targets.set(svc.name, { dockerfile: svc.dockerfile, ref: ref.value });
  }
  return { ok: true, value: targets };
}

/** Shared preview/reset step: resolve the commit-scoped refs, building and
 * pushing only when `build` (preview); reset reuses the refs with no docker
 * work. Returns the map for the deploy request instead of mutating the yaml. */
export async function prepareServiceImages(
  ctx: CliContext,
  yaml: SproutYaml,
  appImageRef: string,
  selection: ServiceSelection,
  opts: { build: boolean },
): Promise<Result<ServiceImageTargets>> {
  if (selection.clearServices) return { ok: true, value: new Map() };
  const overrides = serviceFlagOverrides(selection.service);
  if (!overrides.ok) return overrides;
  const targets = resolveServiceImageTargets(yaml, appImageRef, overrides.value);
  if (!targets.ok) return targets;
  if (!opts.build) return { ok: true, value: targets.value };
  for (const [name, target] of targets.value) {
    const built = await buildAndPush(
      ctx,
      `service ${name}`,
      target.dockerfile,
      target.ref,
    );
    if (!built.ok) return built;
  }
  return { ok: true, value: targets.value };
}
