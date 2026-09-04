import { E2E_SESSION_PATH } from "./config.ts";

/** Compose-backed suites only run under `bun run test:e2e` (sets PB_E2E_MANAGED). */
export function isE2eManaged(): boolean {
  return process.env.PB_E2E_MANAGED === "1";
}

/** Demo-image build + future full acceptance — opt in with PB_E2E_FULL=1. */
export function isE2eFull(): boolean {
  return process.env.PB_E2E_FULL === "1";
}

/**
 * Managed latch written by `e2e/run.ts` after the gateway is healthy.
 * Returns false when unmanaged (caller should skip). Throws if managed but
 * the marker is missing.
 */
export async function assertSessionLatch(): Promise<boolean> {
  if (!isE2eManaged()) return false;
  if (!(await Bun.file(E2E_SESSION_PATH).exists())) {
    throw new Error(
      `e2e session missing at ${E2E_SESSION_PATH}: run the harness via bun run test:e2e, which starts compose`,
    );
  }
  return true;
}
