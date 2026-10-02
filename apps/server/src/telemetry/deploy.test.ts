import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { createFakeDockerClient } from "../docker/fake.ts";
import {
  createTestApp,
  postDeployAndSettle,
  postDeployToken,
  type TestApp,
} from "../http/test-helpers.ts";
import {
  DEPLOY_FAILED_EVENT_KEYS,
  DEPLOY_SUCCESS_EVENT_KEYS,
  type TelemetryDeployEvent,
} from "./payload.ts";
import {
  createTelemetryReporter,
  type TelemetryDeployHook,
} from "./reporter.ts";
import {
  captureConsoleWarn,
  startTelemetryReceiver,
  tempTelemetryDir,
  waitForTelemetry,
  type TelemetryReceiver,
} from "./test-receiver.ts";

const CANARY_REPO = "https://github.com/org/canaryrepo9f3a";
const CANARY_SLUG = "canaryslug9f3a";
const CANARY_HOSTNAME = "pr-42.canaryhostname9f3a.invalid";
const CANARY_IMAGE = "ghcr.io/org/canaryimage9f3a:sha-canary";
const CANARY_APP_ENV = "canary-app-env-9f3a-secret";
const CANARY_DETAIL = "canary-pull-detail-9f3a-secret";
const CANARY_DSN = "canary-dsn-9f3a-secret";

function clearTelemetryEnv(): void {
  delete process.env.SPROUT_TRAEFIK_NETWORK;
  delete process.env.SPROUT_TELEMETRY;
  delete process.env.SPROUT_TELEMETRY_ENDPOINT;
  delete process.env.SPROUT_TELEMETRY_AUTH;
  delete process.env.DO_NOT_TRACK;
}

afterEach(() => {
  clearTelemetryEnv();
});

type DeployHarness = {
  testApp: TestApp;
  deployToken: string;
  receiver: TelemetryReceiver;
  tmp: { dir: string; stateDbPath: string; cleanup: () => Promise<void> };
  cleanup: () => Promise<void>;
};

async function setupDeployHarness(
  respond?: (req: Request) => Response | Promise<Response>,
): Promise<DeployHarness> {
  const receiver = await startTelemetryReceiver(respond as never);
  const tmp = await tempTelemetryDir();
  process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
  process.env.SPROUT_TELEMETRY_ENDPOINT = receiver.url;
  process.env.SPROUT_TELEMETRY_AUTH = "Basic test-value";
  const config = loadConfig();
  // The hook must exist before the app binds its routes, while the reporter
  // needs the app's database, so a forwarding delegate closes the loop.
  let reporter: TelemetryDeployHook | undefined;
  const testApp = await createTestApp({
    postgres: undefined,
    docker: createFakeDockerClient({
      exposedPorts: { [CANARY_IMAGE]: 3000 },
    }),
    telemetry: {
      reportDeployOutcome: (outcome) =>
        reporter?.reportDeployOutcome(outcome),
    },
  });
  reporter = createTelemetryReporter({
    config,
    db: testApp.db,
    stateDbPath: tmp.stateDbPath,
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: CANARY_REPO,
    slug: CANARY_SLUG,
  });
  return {
    testApp,
    deployToken: body.token as string,
    receiver,
    tmp,
    cleanup: async () => {
      await testApp.cleanup();
      await tmp.cleanup();
      receiver.stop();
    },
  };
}

function deployEvents(receiver: TelemetryReceiver): TelemetryDeployEvent[] {
  return receiver.captured.map(
    (req) => (req.body as TelemetryDeployEvent[])[0]!,
  );
}

describe("deploy telemetry", () => {
  test("successful deploy exports the exact success payload", async () => {
    const h = await setupDeployHarness();
    try {
      const res = await postDeployAndSettle(h.testApp, h.deployToken, {
        canonical_repo_id: CANARY_REPO,
        pr_id: 42,
        slug: CANARY_SLUG,
        hostname: CANARY_HOSTNAME,
        app_image: CANARY_IMAGE,
        app_env: [`CANARY_KEY=${CANARY_APP_ENV}`],
        db: { provider: "sqlite" },
      });
      expect(res.outcome).toBe("ready");
      await waitForTelemetry(() => deployEvents(h.receiver).length > 0);
      const events = deployEvents(h.receiver);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect([...Object.keys(event)].sort()).toEqual(
        [...DEPLOY_SUCCESS_EVENT_KEYS].sort(),
      );
      expect(event.event).toBe("deploy");
      expect(event.outcome).toBe("running");
      expect(event.plan).toBe("full_replace");
      expect(event.seeded).toBe(false);
      expect(typeof event.duration_ms).toBe("number");
      expect(event.db_provider).toBe("sqlite");
      // Privacy: canaries from every forbidden source stay out of the body.
      const serialized = JSON.stringify(event);
      for (const canary of [
        CANARY_REPO,
        CANARY_SLUG,
        CANARY_HOSTNAME,
        CANARY_IMAGE,
        CANARY_APP_ENV,
        CANARY_DSN,
      ]) {
        expect(serialized).not.toContain(canary);
      }
    } finally {
      await h.cleanup();
    }
  });

  test("failed deploy carries class and family, never detail", async () => {
    const h = await setupDeployHarness();
    try {
      const docker = h.testApp.docker as {
        pullImage: (image: string) => Promise<unknown>;
      };
      docker.pullImage = async () => {
        throw new Error(`registry hiccup ${CANARY_DETAIL}`);
      };
      const res = await postDeployAndSettle(h.testApp, h.deployToken, {
        canonical_repo_id: CANARY_REPO,
        pr_id: 43,
        slug: CANARY_SLUG,
        hostname: CANARY_HOSTNAME,
        app_image: CANARY_IMAGE,
        db: { provider: "sqlite" },
      });
      expect(res.outcome).toBe("failed");
      await waitForTelemetry(() => deployEvents(h.receiver).length > 0);
      const [event] = deployEvents(h.receiver);
      expect([...Object.keys(event!)].sort()).toEqual(
        [...DEPLOY_FAILED_EVENT_KEYS].sort(),
      );
      expect(event?.outcome).toBe("failed");
      expect(event?.failure_class).toBe("preview_app_pull_failed");
      expect(event?.failure_family).toBeNull();
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(CANARY_DETAIL);
      expect(serialized).not.toContain("lastErrorDetail");
      expect(serialized).not.toContain(CANARY_REPO);
      expect(serialized).not.toContain(CANARY_SLUG);
      expect(serialized).not.toContain(CANARY_HOSTNAME);
      expect(serialized).not.toContain(CANARY_IMAGE);
    } finally {
      await h.cleanup();
    }
  });

  test("deploys complete while hanging exports are still open", async () => {
    const h = await setupDeployHarness(
      () => new Promise<Response>(() => {}),
    );
    const { warns, restore } = captureConsoleWarn();
    try {
      for (const prId of [42, 43, 44]) {
        const res = await postDeployAndSettle(h.testApp, h.deployToken, {
          canonical_repo_id: CANARY_REPO,
          pr_id: prId,
          slug: `${CANARY_SLUG}${prId}`,
          hostname: `pr-${prId}.canaryhostname9f3a.invalid`,
          app_image: CANARY_IMAGE,
          db: { provider: "sqlite" },
        });
        expect(res.outcome).toBe("ready");
      }
      await waitForTelemetry(() => deployEvents(h.receiver).length === 3);
      expect(deployEvents(h.receiver)).toHaveLength(3);
      void warns;
    } finally {
      restore();
      await h.cleanup();
    }
  });

  test("closed port, 401, 403 and 500 never break a deploy", async () => {
    const statuses: Array<number | "closed"> = ["closed", 401, 403, 500];
    for (const status of statuses) {
      const h =
        status === "closed"
          ? await setupDeployHarness()
          : await setupDeployHarness(
              () => new Response("nope", { status }),
            );
      const { warns, restore } = captureConsoleWarn();
      try {
        if (status === "closed") {
          h.receiver.stop();
          process.env.SPROUT_TELEMETRY_ENDPOINT =
            "http://127.0.0.1:1/api/o/s/_json";
        }
        const res = await postDeployAndSettle(h.testApp, h.deployToken, {
          canonical_repo_id: CANARY_REPO,
          pr_id: 42,
          slug: CANARY_SLUG,
          hostname: CANARY_HOSTNAME,
          app_image: CANARY_IMAGE,
          db: { provider: "sqlite" },
        });
        expect(res.outcome).toBe("ready");
        if (status !== "closed") {
          await waitForTelemetry(() => deployEvents(h.receiver).length > 0);
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }
        expect(warns.length).toBeLessThanOrEqual(1);
        if (typeof status === "number") {
          expect(warns).toHaveLength(1);
          expect(warns[0]).toContain(String(status));
        }
      } finally {
        restore();
        await h.cleanup();
        clearTelemetryEnv();
      }
    }
  });
});
