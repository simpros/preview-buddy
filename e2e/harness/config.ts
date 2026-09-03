/** Env + defaults for the e2e acceptance harness. */

export const E2E_COMPOSE_PROJECT = "preview-buddy-e2e";

export const e2eConfig = {
  gatewayUrl:
    process.env.PB_E2E_GATEWAY_URL?.trim() || "http://127.0.0.1:17331",
  traefikUrl:
    process.env.PB_E2E_TRAEFIK_URL?.trim() || "http://127.0.0.1:18880",
  adminToken: process.env.PB_E2E_ADMIN_TOKEN?.trim() || "e2e-admin-token",
  /** Demo images built by the harness from examples/adopting-repo. */
  demoAppImage:
    process.env.PB_E2E_DEMO_APP_IMAGE?.trim() || "preview-buddy-e2e-demo:app",
  demoSeedImage:
    process.env.PB_E2E_DEMO_SEED_IMAGE?.trim() ||
    "preview-buddy-e2e-demo:seed",
  slug: "demoapp",
  canonicalRepoId: "https://github.com/preview-buddy/e2e-demo",
  prId: 42,
};
