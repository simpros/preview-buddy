import { describe, test } from "bun:test";
import { loadE2eSession } from "./harness/session.ts";

const { enabled } = await loadE2eSession();

/**
 * Sweep orphan scenario. Fixture shape lives in fixtures.test.ts; this file
 * is the compose path once #30 exposes a sweep trigger.
 */
describe.skipIf(!enabled)("sweep orphan", () => {
  test.todo("sweep trigger pending #30");
});
