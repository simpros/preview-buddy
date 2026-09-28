import type { CliContext } from "../context.ts";
import type { Result } from "../result.ts";
import { parseServiceFlag } from "../services.ts";
import type { SproutYaml } from "../yaml.ts";
import { buildAndPush } from "./image-build.ts";

function splitTaggedImageRef(appImageRef: string): Result<string> {
  const cut = appImageRef.lastIndexOf(":");
  if (cut <= 0 || cut === appImageRef.length - 1) {
    return {
      ok: false,
      error: `cannot derive service image ref from ${appImageRef}`,
    };
  }
  return { ok: true, value: appImageRef.slice(0, cut) };
}

export function resolveServiceImageRef(
  appImageRef: string,
  serviceName: string,
): Result<string> {
  const repo = splitTaggedImageRef(appImageRef);
  if (!repo.ok) return repo;
  return { ok: true, value: `${appImageRef}-${serviceName}` };
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

export type ServiceImageTargets = Map<string, string>;

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
    targets.set(svc.name, ref.value);
  }
  return { ok: true, value: targets };
}

export function applyServiceImageTargets(
  yaml: SproutYaml,
  targets: ServiceImageTargets,
): void {
  const byName = new Map((yaml.preview.services ?? []).map((s) => [s.name, s]));
  for (const [name, ref] of targets) {
    const entry = byName.get(name);
    if (entry) entry.image = ref;
  }
}

export async function ensureServiceImages(
  ctx: CliContext,
  yaml: SproutYaml,
  appImageRef: string,
  flags: { service: string[]; clearServices: boolean },
): Promise<Result<ServiceImageTargets>> {
  if (flags.clearServices) return { ok: true, value: new Map() };
  const overrides = serviceFlagOverrides(flags.service);
  if (!overrides.ok) return overrides;
  const targets = resolveServiceImageTargets(yaml, appImageRef, overrides.value);
  if (!targets.ok) return targets;
  const byName = new Map((yaml.preview.services ?? []).map((s) => [s.name, s]));
  for (const [name, ref] of targets.value) {
    const entry = byName.get(name);
    const dockerfile = entry?.dockerfile;
    if (dockerfile === undefined) continue;
    const built = await buildAndPush(ctx, `service ${name}`, dockerfile, ref);
    if (!built.ok) return built;
  }
  applyServiceImageTargets(yaml, targets.value);
  return { ok: true, value: targets.value };
}

export function resolveServiceImagesForReset(
  yaml: SproutYaml,
  appImageRef: string,
  flags: { service: string[]; clearServices: boolean },
): Result<ServiceImageTargets> {
  if (flags.clearServices) return { ok: true, value: new Map() };
  const overrides = serviceFlagOverrides(flags.service);
  if (!overrides.ok) return overrides;
  const targets = resolveServiceImageTargets(yaml, appImageRef, overrides.value);
  if (!targets.ok) return targets;
  applyServiceImageTargets(yaml, targets.value);
  return { ok: true, value: targets.value };
}
