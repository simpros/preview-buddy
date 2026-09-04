import { E2E_SESSION_PATH } from "./config.ts";

export type E2eSessionFile = {
  gatewayUrl: string;
  adminToken: string;
  generatedAt: string;
};

export type E2eSession = {
  enabled: boolean;
  gatewayUrl: string;
  adminToken: string;
};

/** Compose-backed suites only run under `bun run test:e2e` (sets PB_E2E_MANAGED). */
export function isE2eManaged(): boolean {
  return (
    process.env.PB_E2E_MANAGED === "1" || process.env.PB_E2E === "1"
  );
}

/** Lifecycle / sweep scenarios pending #25–#31 — opt in with PB_E2E_FULL=1. */
export function isE2eFull(): boolean {
  return process.env.PB_E2E_FULL === "1";
}

/**
 * Read the session artifact written once by `e2e/run.ts` after the gateway is
 * healthy. Does not wait, probe, or talk to Docker.
 */
export async function loadE2eSession(): Promise<E2eSession> {
  if (!isE2eManaged()) {
    return { enabled: false, gatewayUrl: "", adminToken: "" };
  }

  const file = Bun.file(E2E_SESSION_PATH);
  if (!(await file.exists())) {
    throw new Error(
      `e2e session missing at ${E2E_SESSION_PATH}: run the harness via bun run test:e2e, which starts compose`,
    );
  }

  const session = (await file.json()) as E2eSessionFile;
  if (!session.gatewayUrl || !session.adminToken) {
    throw new Error(
      `e2e session at ${E2E_SESSION_PATH} is incomplete: run the harness via bun run test:e2e, which starts compose`,
    );
  }

  return {
    enabled: true,
    gatewayUrl: session.gatewayUrl,
    adminToken: session.adminToken,
  };
}
