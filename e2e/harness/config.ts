/** Env + defaults for the e2e acceptance harness.
 *
 * Host ports and admin token are required keys in `e2e/compose.e2e.env` (the
 * same file passed to `docker compose --env-file`). `PB_E2E_*` process-env
 * overrides remain for local debugging.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_COMPOSE_PROJECT = "preview-buddy-e2e";

export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const COMPOSE_E2E_ENV_PATH = join(repoRoot, "e2e/compose.e2e.env");
export const E2E_SESSION_PATH = join(repoRoot, "e2e/.session.json");

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function requireComposeEnv(
  env: Record<string, string>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(
      `e2e/compose.e2e.env missing required key ${key}`,
    );
  }
  return value;
}

const composeEnv = parseEnvFile(COMPOSE_E2E_ENV_PATH);

const gatewayHostPort = requireComposeEnv(composeEnv, "PB_GATEWAY_HOST_PORT");
const traefikHttpPort = requireComposeEnv(composeEnv, "TRAEFIK_HTTP_PORT");
const composeAdminToken = requireComposeEnv(composeEnv, "PB_ADMIN_TOKEN");

export const e2eConfig = {
  gatewayUrl:
    process.env.PB_E2E_GATEWAY_URL?.trim() ||
    `http://127.0.0.1:${gatewayHostPort}`,
  traefikUrl:
    process.env.PB_E2E_TRAEFIK_URL?.trim() ||
    `http://127.0.0.1:${traefikHttpPort}`,
  adminToken:
    process.env.PB_E2E_ADMIN_TOKEN?.trim() || composeAdminToken,
  /** Demo images built by the harness from examples/adopting-repo (PB_E2E_FULL). */
  demoAppImage:
    process.env.PB_E2E_DEMO_APP_IMAGE?.trim() || "preview-buddy-e2e-demo:app",
  demoSeedImage:
    process.env.PB_E2E_DEMO_SEED_IMAGE?.trim() ||
    "preview-buddy-e2e-demo:seed",
  slug: "demoapp",
  canonicalRepoId: "https://github.com/preview-buddy/e2e-demo",
  prId: 42,
};
