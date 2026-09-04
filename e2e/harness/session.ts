import {
  probeCapabilities,
  type GatewayCapabilities,
} from "./gateway.ts";
import { waitForGateway } from "./stack.ts";

export type E2eSession = {
  enabled: boolean;
  caps: GatewayCapabilities;
};

const disabledCaps: GatewayCapabilities = {
  deploy: false,
  teardown: false,
  previews: false,
  doctor: false,
};

/** Compose-backed suites only run under `bun run test:e2e` (sets PB_E2E_MANAGED). */
export function isE2eManaged(): boolean {
  return (
    process.env.PB_E2E_MANAGED === "1" || process.env.PB_E2E === "1"
  );
}

export async function loadE2eSession(): Promise<E2eSession> {
  if (!isE2eManaged()) {
    return { enabled: false, caps: disabledCaps };
  }
  await waitForGateway(180_000);
  return { enabled: true, caps: await probeCapabilities() };
}
