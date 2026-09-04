#!/usr/bin/env bun
/**
 * Bring up the e2e compose stack, run acceptance tests, tear down.
 *
 *   bun run test:e2e
 *
 * Requires Docker. Fixture-only (no Docker): bun run test:e2e:fixtures
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDemoImages,
  composeDown,
  composeUp,
} from "./harness/stack.ts";

const e2eDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("e2e: composing stack down (clean slate)…");
  await composeDown();

  console.log("e2e: building demo adopting-repo images…");
  await buildDemoImages();

  console.log("e2e: composing stack up…");
  await composeUp();

  process.env.PB_E2E_MANAGED = "1";
  try {
    // Gateway wait lives in loadE2eSession() (single polling point).
    console.log("e2e: running bun test…");
    const proc = Bun.spawn({
      cmd: ["bun", "test", e2eDir],
      cwd: join(e2eDir, ".."),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        PB_E2E_MANAGED: "1",
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      process.exit(code);
    }
  } finally {
    console.log("e2e: composing stack down…");
    await composeDown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
