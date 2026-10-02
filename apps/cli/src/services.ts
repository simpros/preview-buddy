import {
  copyServiceExtras,
  MAX_SERVICES,
  SERVICE_NAME_RE,
  type PreviewServiceSpec,
} from "@sprout/preview-env";
import { expandAppEnvValue, type AppEnvResolveContext } from "./app-env-values.ts";
import type { Result } from "./result.ts";
import type { SproutYamlService } from "./yaml.ts";

export type DeployService = PreviewServiceSpec;

export function parseServiceFlag(raw: string): Result<{ name: string; image: string }> {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    return { ok: false, error: `invalid --service: ${raw}` };
  }
  const name = raw.slice(0, eq).trim();
  const image = raw.slice(eq + 1).trim();
  if (!SERVICE_NAME_RE.test(name) || image === "") {
    return { ok: false, error: `invalid --service: ${raw}` };
  }
  return { ok: true, value: { name, image } };
}

export function mergeServices(
  yamlServices: SproutYamlService[] | undefined,
  flagValues: string[],
): Result<DeployService[] | undefined> {
  const byName = new Map<string, SproutYamlService>();

  for (const svc of yamlServices ?? []) {
    const entry: SproutYamlService = { name: svc.name };
    if (svc.image) entry.image = svc.image;
    if (svc.hostname) entry.hostname = svc.hostname;
    if (svc.path) entry.path = svc.path;
    copyServiceExtras(svc, entry);
    byName.set(svc.name, entry);
  }

  for (const raw of flagValues) {
    const parsed = parseServiceFlag(raw);
    if (!parsed.ok) return parsed;
    const prior = byName.get(parsed.value.name);
    if (prior) {
      prior.image = parsed.value.image;
    } else {
      byName.set(parsed.value.name, {
        name: parsed.value.name,
        image: parsed.value.image,
      });
    }
  }

  if (byName.size === 0) return { ok: true, value: undefined };
  if (byName.size > MAX_SERVICES) {
    return { ok: false, error: `at most ${MAX_SERVICES} services` };
  }

  const out: DeployService[] = [];
  for (const svc of byName.values()) {
    if (!svc.image) {
      return {
        ok: false,
        error: `service ${svc.name} requires an image (--service ${svc.name}=<image>)`,
      };
    }
    const entry: DeployService = { name: svc.name, image: svc.image };
    if (svc.hostname) entry.hostname = svc.hostname;
    if (svc.path) entry.path = svc.path;
    copyServiceExtras(svc, entry);
    out.push(entry);
  }
  return { ok: true, value: out };
}

/** Resolve `{hostname}`/`{pr_id}`/`{commit_sha}` in each service image after manifest/flag merge. */
export function resolveServiceImages(
  services: DeployService[],
  ctx: AppEnvResolveContext,
): Result<DeployService[]> {
  const out: DeployService[] = [];
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const expanded = expandAppEnvValue(svc.image, {
      ...ctx,
      hostname: svc.hostname ?? ctx.hostname,
    });
    if (!expanded.ok) {
      return {
        ok: false,
        error: `preview.services[${i}].image: ${expanded.error}`,
      };
    }
    out.push({ ...svc, image: expanded.value });
  }
  return { ok: true, value: out };
}
