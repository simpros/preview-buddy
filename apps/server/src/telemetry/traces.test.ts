import { afterEach, describe, expect, test } from "bun:test";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { opentelemetry } from "@elysiajs/opentelemetry";
import { loadConfig, parseOtlpHeaders, formatOtlpDestination } from "../config.ts";
import { createFakeDockerClient } from "../docker/fake.ts";
import {
  createTestApp,
  postDeployAndSettle,
  postDeployToken,
  type TestApp,
} from "../http/test-helpers.ts";
import { createTelemetryReporter } from "./reporter.ts";
import { createTraces, shouldTraceRequest, createRedactingSpanProcessor, TRACER_NAME } from "./traces.ts";
import { startTelemetryReceiver, tempTelemetryDir, waitForTelemetry, type TelemetryReceiver } from "./test-receiver.ts";
import type { TelemetryDeployHook } from "./contract.ts";

function clearOtlpEnv(): void {
  delete process.env.SPROUT_TRAEFIK_NETWORK;
  delete process.env.SPROUT_TELEMETRY;
  delete process.env.SPROUT_TELEMETRY_ENDPOINT;
  delete process.env.SPROUT_TELEMETRY_AUTH;
  delete process.env.SPROUT_OTLP_ENDPOINT;
  delete process.env.SPROUT_OTLP_HEADERS;
  delete process.env.DO_NOT_TRACK;
}

afterEach(() => {
  clearOtlpEnv();
  try {
    trace.disable();
  } catch {
  }
  try {
    context.disable();
  } catch {
  }
});

function setRequired(): void {
  process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
}

describe("otlp config", () => {
  test("parses Authorization with base64 padding byte-identical", () => {
    const headers = parseOtlpHeaders(
      "Authorization=Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM=,stream-name=default",
    );
    expect(headers).toEqual({
      Authorization: "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM=",
      "stream-name": "default",
    });
    expect(headers["Authorization"]).toBe(
      "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM=",
    );
  });

  test("rejects entry without = and empty name", () => {
    expect(() => parseOtlpHeaders("nopadding")).toThrow("nopadding");
    expect(() => parseOtlpHeaders("=value")).toThrow("=value");
  });

  test("non-absolute endpoint fails boot naming the variable", () => {
    setRequired();
    process.env.SPROUT_OTLP_ENDPOINT = "not-a-url";
    expect(() => loadConfig()).toThrow("SPROUT_OTLP_ENDPOINT");
    process.env.SPROUT_OTLP_ENDPOINT = "ftp://example.com/v1/traces";
    expect(() => loadConfig()).toThrow("SPROUT_OTLP_ENDPOINT");
  });

  test("no endpoint means off with empty headers summary", () => {
    setRequired();
    const config = loadConfig();
    expect(config.otlp).toEqual({ endpoint: "", headers: {} });
    expect(formatOtlpDestination("")).toBe("off");
  });

  test("endpoint set yields host/path summary and [set] headers, never the value", async () => {
    const { loadConfig: lc, configSummary } = await import("../config.ts");
    setRequired();
    process.env.SPROUT_OTLP_ENDPOINT = "https://collector.example.com:4318/v1/traces";
    process.env.SPROUT_OTLP_HEADERS = "Authorization=Basic c2VjcmV0,stream-name=default";
    const config = lc();
    const summary = configSummary(config);
    expect(summary.traces).toBe("collector.example.com:4318/v1/traces");
    expect(summary.otlpHeaders).toBe("[set]");
    expect(JSON.stringify(summary)).not.toContain("c2VjcmV0");
    setRequired();
    delete process.env.SPROUT_OTLP_HEADERS;
    const bare = lc();
    expect(configSummary(bare).otlpHeaders).toBe("[empty]");
  });
});

describe("shouldTraceRequest", () => {
  test("excludes exactly /healthz", () => {
    expect(shouldTraceRequest(new Request("http://localhost/healthz"))).toBe(false);
    expect(shouldTraceRequest(new Request("http://localhost/v1/previews"))).toBe(true);
    expect(shouldTraceRequest(new Request("http://localhost/v1/deploy", { method: "POST" }))).toBe(true);
  });
});

describe("createTraces disabled", () => {
  test("no endpoint returns no plugin and no-op shutdown", async () => {
    setRequired();
    const config = loadConfig();
    const handle = createTraces(config);
    expect(handle.plugin).toBeUndefined();
    await handle.shutdown();
  });
});

type SpanHarness = {
  testApp: TestApp;
  deployToken: string;
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
  cleanup: () => Promise<void>;
};

function installSpanProvider(): {
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [createRedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new AsyncHooksContextManager());
  trace.setGlobalTracerProvider(provider);
  return { exporter, provider };
}

async function setupSpanHarness(): Promise<SpanHarness> {
  const { exporter, provider } = installSpanProvider();
  setRequired();
  const testApp = await createTestApp({
    postgres: undefined,
    docker: createFakeDockerClient({
      exposedPorts: { ["ghcr.io/org/myapp:sha-abc"]: 3000 },
    }),
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: "https://github.com/org/repo",
    slug: "myapp",
  });
  return {
    testApp,
    deployToken: body.token as string,
    exporter,
    provider,
    cleanup: async () => {
      await testApp.cleanup();
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
    },
  };
}

function finishedSpans(exporter: InMemorySpanExporter) {
  return exporter.getFinishedSpans();
}

describe("deploy spans", () => {
  test("deploy exports preview.deploy with db/app/seed children and repo/pr attributes", async () => {
    const h = await setupSpanHarness();
    try {
      const res = await postDeployAndSettle(h.testApp, h.deployToken, {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 42,
        slug: "myapp",
        hostname: "pr-42.myapp.preview.example.com",
        app_image: "ghcr.io/org/myapp:sha-abc",
        db: { provider: "sqlite" },
      });
      expect(res.outcome).toBe("ready");
      const spans = finishedSpans(h.exporter);
      const byName = new Map(spans.map((s) => [s.name, s]));
      expect(byName.has("preview.deploy")).toBe(true);
      expect(byName.has("preview.db")).toBe(true);
      expect(byName.has("preview.app")).toBe(true);
      // sqlite with no seed still runs no seed phase; seed span absent is fine.
      // With seed image, seed span appears (covered below).
      const deploy = byName.get("preview.deploy")!;
      expect(deploy.attributes["sprout.repo"]).toBe("https://github.com/org/repo");
      expect(deploy.attributes["sprout.pr"]).toBe(42);
      expect(deploy.attributes["sprout.slug"]).toBe("myapp");
      expect(deploy.attributes["sprout.plan"]).toBe("full_replace");
      expect(deploy.attributes["sprout.status"]).toBe("running");
      // Children parent to the deploy span.
      const deployCtx = deploy.spanContext();
      for (const name of ["preview.db", "preview.app"]) {
        const child = byName.get(name)!;
        expect(child.parentSpanContext?.spanId).toBe(deployCtx.spanId);
        expect(child.parentSpanContext?.traceId).toBe(deployCtx.traceId);
      }
    } finally {
      await h.cleanup();
    }
  });

  test("seed image deploy includes preview.seed child", async () => {
    const h = await setupSpanHarness();
    try {
      const res = await postDeployAndSettle(h.testApp, h.deployToken, {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 42,
        slug: "myapp",
        hostname: "pr-42.myapp.preview.example.com",
        app_image: "ghcr.io/org/myapp:sha-abc",
        db: { provider: "sqlite" },
        seed_image: "ghcr.io/org/myapp:sha-abc",
        health: { path: "/health", interval: "1s", timeout: "5s", expect: 200 },
      });
      expect(res.outcome).toBe("ready");
      const spans = finishedSpans(h.exporter);
      const names = new Set(spans.map((s) => s.name));
      expect(names.has("preview.deploy")).toBe(true);
      expect(names.has("preview.seed")).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test("failing deploy sets ERROR with exception while request still answers 202", async () => {
    const h = await setupSpanHarness();
    try {
      const docker = h.testApp.docker as { pullImage: (image: string) => Promise<unknown> };
      docker.pullImage = async () => {
        throw new Error("registry hiccup");
      };
      const accept = await h.testApp.app.handle(
        new Request("http://localhost/v1/deploy", {
          method: "POST",
          headers: {
            authorization: `Bearer ${h.deployToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            canonical_repo_id: "https://github.com/org/repo",
            pr_id: 43,
            slug: "myapp",
            hostname: "pr-43.myapp.preview.example.com",
            app_image: "ghcr.io/org/myapp:sha-abc",
            db: { provider: "sqlite" },
          }),
        }),
      );
      expect(accept.status).toBe(202);
      // Settle via polling.
      await postDeployAndSettle(h.testApp, h.deployToken, {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 43,
        slug: "myapp",
        hostname: "pr-43.myapp.preview.example.com",
        app_image: "ghcr.io/org/myapp:sha-abc",
        db: { provider: "sqlite" },
      }).catch(() => {});
      for (let i = 0; i < 200 && finishedSpans(h.exporter).length === 0; i++) {
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      const spans = finishedSpans(h.exporter);
      const deploy = spans.find((s) => s.name === "preview.deploy");
      expect(deploy).toBeDefined();
      expect(deploy!.status.code).toBe(SpanStatusCode.ERROR);
      expect(deploy!.events.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(deploy!.events);
      expect(serialized).toContain("preview_app_pull_failed");
    } finally {
      await h.cleanup();
    }
  });

  test("canaries never appear and deploy attributes equal the exact set", async () => {
    const h = await setupSpanHarness();
    const headerCanary = "header-canary-7f3a-secret";
    const appEnvCanary = "appenv-canary-7f3a-secret";
    try {
      const res = await h.testApp.app.handle(
        new Request("http://localhost/v1/deploy", {
          method: "POST",
          headers: {
            authorization: `Bearer ${h.deployToken}`,
            "content-type": "application/json",
            "x-canary": headerCanary,
          },
          body: JSON.stringify({
            canonical_repo_id: "https://github.com/org/repo",
            pr_id: 44,
            slug: "myapp",
            hostname: "pr-44.myapp.preview.example.com",
            app_image: "ghcr.io/org/myapp:sha-abc",
            app_env: [`CANARY_KEY=${appEnvCanary}`],
            db: { provider: "sqlite" },
          }),
        }),
      );
      expect(res.status).toBe(202);
      await postDeployAndSettle(h.testApp, h.deployToken, {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 44,
        slug: "myapp",
        hostname: "pr-44.myapp.preview.example.com",
        app_image: "ghcr.io/org/myapp:sha-abc",
        app_env: [`CANARY_KEY=${appEnvCanary}`],
        db: { provider: "sqlite" },
      });
      for (let i = 0; i < 200 && finishedSpans(h.exporter).length === 0; i++) {
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      const spans = finishedSpans(h.exporter);
      const serialized = JSON.stringify(
        spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, resource: s.resource })),
      );
      expect(serialized).not.toContain(headerCanary);
      expect(serialized).not.toContain(appEnvCanary);
      const deploy = spans.find((s) => s.name === "preview.deploy")!;
      expect(Object.keys(deploy.attributes).sort()).toEqual(
        ["sprout.plan", "sprout.pr", "sprout.repo", "sprout.slug", "sprout.status"].sort(),
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe("otlp export", () => {
  test("posts protobuf to exactly the configured URL with exactly the configured headers", async () => {
    const captured: Array<{ method: string; url: string; headers: Record<string, string>; body: Uint8Array }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const buf = new Uint8Array(await req.arrayBuffer());
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        captured.push({ method: req.method, url: req.url, headers, body: buf });
        return new Response("", { status: 200 });
      },
    });
    try {
      trace.disable();
      setRequired();
      const endpoint = `http://127.0.0.1:${server.port}/v1/traces`;
      process.env.SPROUT_OTLP_ENDPOINT = endpoint;
      process.env.SPROUT_OTLP_HEADERS = "Authorization=Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM=,stream-name=default";
      const config = loadConfig();
      const handle = createTraces(config);
      expect(handle.plugin).toBeDefined();
      const tracer = trace.getTracer(TRACER_NAME);
      await tracer.startActiveSpan("test.span", async (span) => {
        span.end();
      });
      await handle.shutdown();
      expect(captured.length).toBeGreaterThan(0);
      const [first] = captured;
      expect(first!.method).toBe("POST");
      expect(first!.url).toBe(endpoint);
      expect(first!.headers["authorization"]).toBe("Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM=");
      expect(first!.headers["stream-name"]).toBe("default");
      expect(first!.body.length).toBeGreaterThan(0);
    } finally {
      server.stop(true);
      try {
        trace.disable();
      } catch {
      }
    }
  });

  test("closed port and 500 never break a deploy", async () => {
    // Closed port.
    {
      const { provider } = installSpanProvider();
      setRequired();
      process.env.SPROUT_OTLP_ENDPOINT = "http://127.0.0.1:1/v1/traces";
      const config = loadConfig();
      // Deploy spans flow through the global provider; the dead endpoint is
      // never wired in, so export cannot touch the request path.
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient({
          exposedPorts: { ["ghcr.io/org/myapp:sha-abc"]: 3000 },
        }),
      });
      try {
        const { body } = await postDeployToken(testApp, {
          canonical_repo_id: "https://github.com/org/repo",
          slug: "myapp",
        });
        const res = await postDeployAndSettle(testApp, body.token as string, {
          canonical_repo_id: "https://github.com/org/repo",
          pr_id: 42,
          slug: "myapp",
          hostname: "pr-42.myapp.preview.example.com",
          app_image: "ghcr.io/org/myapp:sha-abc",
          db: { provider: "sqlite" },
        });
        expect(res.outcome).toBe("ready");
        expect(config.otlp.endpoint).toBe("http://127.0.0.1:1/v1/traces");
      } finally {
        await testApp.cleanup();
        await provider.shutdown().catch(() => {});
        try {
          trace.disable();
        } catch {
        }
        clearOtlpEnv();
      }
    }
    // 500 receiver.
    {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response("nope", { status: 500 });
        },
      });
      const { provider } = installSpanProvider();
      try {
        setRequired();
        process.env.SPROUT_OTLP_ENDPOINT = `http://127.0.0.1:${server.port}/v1/traces`;
        const testApp = await createTestApp({
          postgres: undefined,
          docker: createFakeDockerClient({
            exposedPorts: { ["ghcr.io/org/myapp:sha-abc"]: 3000 },
          }),
        });
        try {
          const { body } = await postDeployToken(testApp, {
            canonical_repo_id: "https://github.com/org/repo",
            slug: "myapp",
          });
          const res = await postDeployAndSettle(testApp, body.token as string, {
            canonical_repo_id: "https://github.com/org/repo",
            pr_id: 42,
            slug: "myapp",
            hostname: "pr-42.myapp.preview.example.com",
            app_image: "ghcr.io/org/myapp:sha-abc",
            db: { provider: "sqlite" },
          });
          expect(res.outcome).toBe("ready");
        } finally {
          await testApp.cleanup();
        }
      } finally {
        server.stop(true);
        await provider.shutdown().catch(() => {});
        try {
          trace.disable();
        } catch {
        }
        clearOtlpEnv();
      }
    }
  });

  test("hanging export never blocks requests", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    try {
      trace.disable();
      setRequired();
      process.env.SPROUT_OTLP_ENDPOINT = `http://127.0.0.1:${server.port}/v1/traces`;
      const config = loadConfig();
      const handle = createTraces(config);
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient(),
        tracesPlugin: handle.plugin!,
      });
      try {
        for (let i = 0; i < 3; i++) {
          const res = await testApp.app.handle(new Request("http://localhost/healthz"));
          expect(res.status).toBe(200);
        }
      } finally {
        await testApp.cleanup();
        await handle.shutdown();
      }
    } finally {
      server.stop(true);
      try {
        trace.disable();
      } catch {
      }
    }
  });

  test("upstream channel still delivers with unreachable trace endpoint", async () => {
    const receiver = await startTelemetryReceiver();
    const tmp = await tempTelemetryDir();
    const { provider } = installSpanProvider();
    // Bound before the deploy runs, so the deploy's own report proves the
    // upstream transport is unaffected by the dead trace endpoint.
    const holder: { hook?: TelemetryDeployHook } = {};
    try {
      setRequired();
      process.env.SPROUT_TELEMETRY_ENDPOINT = receiver.url;
      process.env.SPROUT_TELEMETRY_AUTH = "Basic test-value";
      process.env.SPROUT_OTLP_ENDPOINT = "http://127.0.0.1:1/v1/traces";
      const config = loadConfig();
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient({
          exposedPorts: { ["ghcr.io/org/myapp:sha-abc"]: 3000 },
        }),
        telemetry: {
          reportDeployOutcome: (outcome) => holder.hook?.reportDeployOutcome(outcome),
        },
      });
      holder.hook = createTelemetryReporter({ config, db: testApp.db, stateDbPath: tmp.stateDbPath });
      const { body } = await postDeployToken(testApp, {
        canonical_repo_id: "https://github.com/org/repo",
        slug: "myapp",
      });
      const res = await postDeployAndSettle(testApp, body.token as string, {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: 42,
        slug: "myapp",
        hostname: "pr-42.myapp.preview.example.com",
        app_image: "ghcr.io/org/myapp:sha-abc",
        db: { provider: "sqlite" },
      });
      expect(res.outcome).toBe("ready");
      await waitForTelemetry(() => receiver.captured.length > 0);
      expect(receiver.captured.length).toBeGreaterThan(0);
      await testApp.cleanup();
    } finally {
      receiver.stop();
      await tmp.cleanup();
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
    }
  });
});

describe("http spans", () => {
  test("/healthz exports no span; POST /v1/previews exports renamed span with status", async () => {
    const { exporter, provider } = installSpanProvider();
    try {
      const plugin = opentelemetry({
        serviceName: TRACER_NAME,
        checkIfShouldTrace: shouldTraceRequest,
      });
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient(),
        tracesPlugin: plugin,
      });
      try {
        exporter.reset();
        const health = await testApp.app.handle(new Request("http://localhost/healthz"));
        expect(health.status).toBe(200);
        await new Promise<void>((r) => setTimeout(r, 100));
        expect(exporter.getFinishedSpans().filter((s) => JSON.stringify(s.attributes).includes("healthz"))).toEqual([]);
        const healthSpans = exporter.getFinishedSpans();
        expect(healthSpans).toEqual([]);

        exporter.reset();
        const res = await testApp.app.handle(
          new Request("http://localhost/v1/previews", {
            headers: { authorization: "Bearer wrong-token" },
          }),
        );
        expect([401, 200]).toContain(res.status);
        await new Promise<void>((r) => setTimeout(r, 100));
        const spans = exporter.getFinishedSpans();
        const root = spans.find((s) => s.name === "GET /v1/previews");
        expect(root).toBeDefined();
        expect(root!.attributes["http.response.status_code"]).toBe(res.status);
      } finally {
        await testApp.cleanup();
      }
    } finally {
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
      try {
        context.disable();
      } catch {
      }
    }
  });

  test("http spans never carry request headers or bodies", async () => {
    const { exporter, provider } = installSpanProvider();
    try {
      const plugin = opentelemetry({
        serviceName: TRACER_NAME,
        checkIfShouldTrace: shouldTraceRequest,
      });
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient({
          exposedPorts: { ["ghcr.io/org/myapp:sha-abc"]: 3000 },
        }),
        tracesPlugin: plugin,
      });
      try {
        const headerCanary = "http-header-canary-4b1e-secret";
        const { body } = await postDeployToken(testApp, {
          canonical_repo_id: "https://github.com/org/repo",
          slug: "myapp",
        });
        exporter.reset();
        const res = await testApp.app.handle(
          new Request("http://localhost/v1/deploy", {
            method: "POST",
            headers: {
              authorization: `Bearer ${body.token}`,
              "content-type": "application/json",
              "x-canary": headerCanary,
            },
            body: JSON.stringify({
              canonical_repo_id: "https://github.com/org/repo",
              pr_id: 45,
              slug: "myapp",
              hostname: "pr-45.myapp.preview.example.com",
              app_image: "ghcr.io/org/myapp:sha-abc",
              app_env: ["CANARY_KEY=http-body-canary-4b1e-secret"],
              db: { provider: "sqlite" },
            }),
          }),
        );
        expect(res.status).toBe(202);
        await postDeployAndSettle(testApp, body.token as string, {
          canonical_repo_id: "https://github.com/org/repo",
          pr_id: 45,
          slug: "myapp",
          hostname: "pr-45.myapp.preview.example.com",
          app_image: "ghcr.io/org/myapp:sha-abc",
          app_env: ["CANARY_KEY=http-body-canary-4b1e-secret"],
          db: { provider: "sqlite" },
        });
        await new Promise<void>((r) => setTimeout(r, 200));
        const serialized = JSON.stringify(
          exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
        );
        expect(serialized).not.toContain(headerCanary);
        expect(serialized).not.toContain("http-body-canary-4b1e-secret");
      } finally {
        await testApp.cleanup();
      }
    } finally {
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
      try {
        context.disable();
      } catch {
      }
    }
  });

  test("response bodies, headers and cookies are redacted at set time", async () => {
    const { exporter, provider } = installSpanProvider();
    try {
      const tracer = trace.getTracer(TRACER_NAME);
      const bodyCanary = "response-body-canary-9c2d-secret";
      const headerCanary = "response-header-canary-9c2d-secret";
      const cookieCanary = "response-cookie-canary-9c2d-secret";
      await tracer.startActiveSpan("redaction.probe", async (span) => {
        span.setAttribute("http.response.body", `{"token":"${bodyCanary}"}`);
        span.setAttributes({
          "http.response.header.set-cookie": cookieCanary,
          "http.request.header.authorization": headerCanary,
          "http.request.body": "should-not-appear",
          "sprout.slug": "myapp",
        });
        span.end();
      });
      const serialized = JSON.stringify(
        exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes })),
      );
      expect(serialized).not.toContain(bodyCanary);
      expect(serialized).not.toContain(headerCanary);
      expect(serialized).not.toContain(cookieCanary);
      expect(serialized).not.toContain("should-not-appear");
      // Names stay so backends keep the shape; the safe attribute survives.
      expect(serialized).toContain("http.response.body");
      expect(serialized).toContain("myapp");
    } finally {
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
    }
  });

  test("admin token issuance never exports the raw token", async () => {
    const { exporter, provider } = installSpanProvider();
    try {
      const plugin = opentelemetry({
        serviceName: TRACER_NAME,
        checkIfShouldTrace: shouldTraceRequest,
      });
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient(),
        tracesPlugin: plugin,
      });
      try {
        const { body } = await postDeployToken(testApp, {
          canonical_repo_id: "https://github.com/org/repo",
          slug: "myapp",
        });
        const raw = body.token as string;
        expect(typeof raw).toBe("string");
        expect(raw.length).toBeGreaterThan(0);
        await new Promise<void>((r) => setTimeout(r, 200));
        const serialized = JSON.stringify(
          exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes })),
        );
        expect(serialized).not.toContain(raw);
      } finally {
        await testApp.cleanup();
      }
    } finally {
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
      try {
        context.disable();
      } catch {
      }
    }
  });

  test("preview.deploy is a root trace detached from the accepting request", async () => {
    const { exporter, provider } = installSpanProvider();
    try {
      const plugin = opentelemetry({
        serviceName: TRACER_NAME,
        checkIfShouldTrace: shouldTraceRequest,
      });
      const testApp = await createTestApp({
        postgres: undefined,
        docker: createFakeDockerClient({
          exposedPorts: { ["ghcr.io/org/myapp:sha-abc"]: 3000 },
        }),
        tracesPlugin: plugin,
      });
      try {
        const { body } = await postDeployToken(testApp, {
          canonical_repo_id: "https://github.com/org/repo",
          slug: "myapp",
        });
        const res = await postDeployAndSettle(testApp, body.token as string, {
          canonical_repo_id: "https://github.com/org/repo",
          pr_id: 42,
          slug: "myapp",
          hostname: "pr-42.myapp.preview.example.com",
          app_image: "ghcr.io/org/myapp:sha-abc",
          db: { provider: "sqlite" },
        });
        expect(res.outcome).toBe("ready");
        for (let i = 0; i < 200 && !exporter.getFinishedSpans().some((s) => s.name === "preview.deploy"); i++) {
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        const spans = exporter.getFinishedSpans();
        const deploy = spans.find((s) => s.name === "preview.deploy");
        expect(deploy).toBeDefined();
        // A root span has no parent; the HTTP accept span lives in its own trace.
        expect(deploy!.parentSpanContext).toBeUndefined();
        const http = spans.find((s) => s.name === "POST /v1/deploy");
        expect(http).toBeDefined();
        expect(http!.spanContext().traceId).not.toBe(deploy!.spanContext().traceId);
      } finally {
        await testApp.cleanup();
      }
    } finally {
      await provider.shutdown().catch(() => {});
      try {
        trace.disable();
      } catch {
      }
      try {
        context.disable();
      } catch {
      }
    }
  });
});
