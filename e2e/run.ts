#!/usr/bin/env bun
/**
 * Bring up the e2e compose stack, run acceptance tests, tear down.
 *
 *   bun run test:e2e
 *
 * Requires Docker. Fixture-only (no Docker): bun run test:e2e:fixtures
 *
 * Lifecycle / sweep suites pending #25–#31 stay skipped unless PB_E2E_FULL=1
 * is set in the environment (forwarded into the test process).
 */
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_SESSION_PATH } from "./harness/config.ts";
import type { E2eSessionFile } from "./harness/session.ts";
import {
  buildDemoImages,
  composeDown,
  composeUp,
  waitForGateway,
} from "./harness/stack.ts";

const e2eDir = dirname(fileURLToPath(import.meta.url));

/** Docker-bound tests exceed Bun's 5s default. */
const E2E_TEST_TIMEOUT_MS = "180000";

async function writeSession(): Promise<void> {
  const session: E2eSessionFile = {
    ok: true,
    generatedAt: new Date().toISOString(),
  };
  await Bun.write(E2E_SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`);
}

function clearSession(): void {
  try {
    unlinkSync(E2E_SESSION_PATH);
  } catch {
    // absent is fine
  }
}

async function main() {
  console.log("e2e: composing stack down (clean slate)…");
  await composeDown();

  console.log("e2e: building demo adopting-repo images…");
  await buildDemoImages();

  console.log("e2e: composing stack up…");
  await composeUp();

  let code = 0;
  try {
    console.log("e2e: waiting for gateway…");
    await waitForGateway(180_000);
    await writeSession();

    console.log("e2e: running bun test…");
    const proc = Bun.spawn({
      cmd: ["bun", "test", "--timeout", E2E_TEST_TIMEOUT_MS, e2eDir],
      cwd: join(e2eDir, ".."),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        PB_E2E_MANAGED: "1",
        // PB_E2E_FULL passes through from the caller when set.
      },
    });
    code = await proc.exited;
  } finally {
    clearSession();
    console.log("e2e: composing stack down…");
    await composeDown();
  }
  if (code !== 0) process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
