import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Spec #12 gateway env names that operators must see in `.env.example`. */
const V01_ENV_NAMES = [
  "PB_PREVIEW_POSTGRES_URL",
  "PB_PG_HOST",
  "PB_PG_PORT",
  "PB_PG_USER",
  "PB_PG_PASSWORD",
  "PB_TRAEFIK_NETWORK",
  "PB_POSTGRES_NETWORK",
  "PB_REGISTRY_URL",
  "PB_REGISTRY_USER",
  "PB_REGISTRY_PASSWORD",
  "PB_ADMIN_TOKEN",
  "PB_FORGE",
  "PB_FORGE_TOKEN",
  "PB_PORT",
  "PB_TTL_HOURS",
  "PB_SWEEP_MINUTES",
  "PB_PREVIEW_PORT_DEFAULT",
  "PB_SEED_TIMEOUT",
  "PB_STATE_DB_PATH",
] as const;

function envExampleKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Active assignments and commented optional pins both count as documented.
    const match = trimmed.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

describe(".env.example", () => {
  test("documents every v0.1 gateway env var name", () => {
    const path = join(import.meta.dir, "../../../.env.example");
    const keys = envExampleKeys(readFileSync(path, "utf8"));
    for (const name of V01_ENV_NAMES) {
      expect(keys.has(name), `missing ${name}`).toBe(true);
    }
  });
});
