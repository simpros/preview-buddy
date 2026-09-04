import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSE_E2E_ENV_PATH, E2E_COMPOSE_PROJECT, e2eConfig } from "./config.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function composeArgs(extra: string[]): string[] {
  return [
    "compose",
    "-p",
    E2E_COMPOSE_PROJECT,
    "-f",
    join(repoRoot, "docker-compose.yml"),
    "--env-file",
    COMPOSE_E2E_ENV_PATH,
    ...extra,
  ];
}

async function run(
  cmd: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, COMPOSE_PROJECT_NAME: E2E_COMPOSE_PROJECT },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !opts.allowFailure) {
    throw new Error(
      `${cmd.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`,
    );
  }
  return { exitCode, stdout, stderr };
}

export async function composeUp(): Promise<void> {
  await run(["docker", ...composeArgs(["up", "-d", "--build"])]);
}

export async function composeDown(): Promise<void> {
  await run(["docker", ...composeArgs(["down", "-v", "--remove-orphans"])], {
    allowFailure: true,
  });
}

export async function buildDemoImages(): Promise<void> {
  const demoDir = join(repoRoot, "examples/adopting-repo");
  if (!existsSync(demoDir)) {
    throw new Error(
      `e2e: demo directory missing: ${demoDir} (needed for adopting-repo image builds)`,
    );
  }
  await run([
    "docker",
    "build",
    "-t",
    e2eConfig.demoAppImage,
    "-f",
    join(demoDir, "Dockerfile"),
    demoDir,
  ]);
  await run([
    "docker",
    "build",
    "-t",
    e2eConfig.demoSeedImage,
    "-f",
    join(demoDir, "Dockerfile.seed"),
    demoDir,
  ]);
}

export async function waitForGateway(
  timeoutMs = 120_000,
  intervalMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${e2eConfig.gatewayUrl}/healthz`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
        lastError = `unexpected body ${JSON.stringify(body)}`;
      } else {
        lastError = `status ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(intervalMs);
  }
  const logs = await run(
    ["docker", ...composeArgs(["logs", "--tail", "200", "gateway"])],
    { allowFailure: true },
  );
  throw new Error(
    `gateway at ${e2eConfig.gatewayUrl} not healthy within ${timeoutMs}ms (${lastError})\n` +
      `--- docker compose logs gateway ---\n${logs.stdout}${logs.stderr}`,
  );
}
