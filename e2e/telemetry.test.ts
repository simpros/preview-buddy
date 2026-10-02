import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_EVENT_KEYS } from "../apps/server/src/telemetry/payload.ts";

const enabled = process.env.SPROUT_E2E_MANAGED === "1";
const e2eDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(e2eDir, "..");

type CapturedIngest = {
  authorization: string | null;
  body: unknown;
};

/**
 * Published-image path: the destination is injected at image build time, so
 * the test passes values through the environment (docker reads `--build-arg
 * NAME` and `docker run -e NAME` from it) without ever writing them to a
 * file. The key names below are bare references, never assignments.
 */
const endpointEnvName = "SPROUT_TELEMETRY_ENDPOINT";
const authEnvName = "SPROUT_TELEMETRY_AUTH";
const traefikEnvName = "SPROUT_TRAEFIK_NETWORK";
const statePathEnvName = "SPROUT_STATE_DB_PATH";

async function docker(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

async function waitFor(
  check: () => boolean,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}

async function waitHealthy(port: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - startedAt > 120_000) {
      throw new Error(`timed out: gateway healthy on ${port}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}

const containers: string[] = [];
afterAll(async () => {
  for (const name of containers.splice(0)) {
    await docker(["rm", "-f", name]).catch(() => {});
  }
});

async function startReceiver(): Promise<{
  url: (port: number) => string;
  captured: CapturedIngest[];
  stop: () => void;
  port: number;
}> {
  const captured: CapturedIngest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({
        authorization: req.headers.get("authorization"),
        body: await req.json().catch(() => null),
      });
      return new Response('{"failed":0}', { status: 200 });
    },
  });
  return {
    port: server.port,
    url: (receiverPort: number) =>
      `http://host.docker.internal:${receiverPort}/api/e2eorg/e2estream/_json`,
    captured,
    stop: () => server.stop(true),
  };
}

describe.skipIf(!enabled)("install telemetry image path", () => {
  test("image built with a destination reports on boot", async () => {
    const receiver = await startReceiver();
    const dataDir = await mkdtemp(join(tmpdir(), "sprout-tm-data-"));
    const name = `sprout-telemetry-e2e-${Date.now()}`;
    containers.push(name);
    try {
      const image = "sprout-telemetry-e2e:with-destination";
      await docker(["build", "-t", image, "--build-arg", endpointEnvName, "--build-arg", authEnvName, "."], {
        [endpointEnvName]: receiver.url(receiver.port),
        [authEnvName]: "Basic telemetry-e2e-value",
      });
      const hostPort = 17332;
      await docker([
        "run",
        "-d",
        "--name",
        name,
        "--add-host=host.docker.internal:host-gateway",
        "-p",
        `127.0.0.1:${hostPort}:7331`,
        "-e",
        traefikEnvName,
        "-e",
        endpointEnvName,
        "-e",
        authEnvName,
        "-e",
        `${statePathEnvName}=/data/sprout.db`,
        "-v",
        `${dataDir}:/data`,
        image,
      ], {
        [traefikEnvName]: "sprout-e2e-traefik",
        [endpointEnvName]: receiver.url(receiver.port),
        [authEnvName]: "Basic telemetry-e2e-value",
      });
      await waitHealthy(hostPort);
      await waitFor(
        () => receiver.captured.length > 0,
        "install event at the receiver",
      );
      expect(receiver.captured.length).toBeGreaterThan(0);
      const [first] = receiver.captured;
      expect(first?.authorization).toBe("Basic telemetry-e2e-value");
      const [event] = first?.body as Array<Record<string, unknown>>;
      expect([...Object.keys(event!)].sort()).toEqual(
        [...INSTALL_EVENT_KEYS].sort(),
      );
      expect(event?.event).toBe("install");
      const logs = await docker(["logs", name]);
      expect(logs).toContain("telemetry on → ");
      const installId = event?.install_id as string;
      expect(typeof installId).toBe("string");

      // A restart reuses the same install identity.
      await docker(["restart", name]);
      await waitHealthy(hostPort);
      await waitFor(
        () => receiver.captured.length > 1,
        "second install event after restart",
      );
      const second = (receiver.captured[1]?.body as Array<Record<string, unknown>>)[0];
      expect(second?.install_id).toBe(installId);
    } finally {
      receiver.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("image built with no build args sends zero requests", async () => {
    const receiver = await startReceiver();
    const dataDir = await mkdtemp(join(tmpdir(), "sprout-tm-nodest-"));
    const name = `sprout-telemetry-e2e-nodest-${Date.now()}`;
    containers.push(name);
    try {
      const image = "sprout-telemetry-e2e:no-destination";
      await docker(["build", "-t", image, "."]);
      const hostPort = 17333;
      // The receiver stays unreachable on purpose: with no destination the
      // gateway must not even attempt a connection.
      await docker([
        "run",
        "-d",
        "--name",
        name,
        "-p",
        `127.0.0.1:${hostPort}:7331`,
        "-e",
        `${traefikEnvName}=sprout-e2e-traefik`,
        "-e",
        `${statePathEnvName}=/data/sprout.db`,
        "-v",
        `${dataDir}:/data`,
        image,
      ]);
      await waitHealthy(hostPort);
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      expect(receiver.captured).toEqual([]);
      const logs = await docker(["logs", name]);
      expect(logs).toContain("telemetry on (no destination)");
    } finally {
      receiver.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
