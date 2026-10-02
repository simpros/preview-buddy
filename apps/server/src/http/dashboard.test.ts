import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DASHBOARD_ENV_KEYS,
  loadConfig,
} from "../config.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { bindPreviewDataVolumes } from "../preview/data-volumes.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { NO_TELEMETRY } from "../telemetry/contract.ts";
import { createRoutes } from "./routes.ts";
import {
  bearer,
  bindTestPreviewApp,
  createTestApp,
  postDeployAndSettle,
  postDeployToken,
  type TestApp,
} from "./test-helpers.ts";

const DASHBOARD_USER = "operator";
const DASHBOARD_PASSWORD = "dash-secret-1";
const ENABLED = {
  enabled: true as const,
  user: DASHBOARD_USER,
  password: DASHBOARD_PASSWORD,
};

function basic(user: string, password: string): HeadersInit {
  return {
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  };
}

function dashboardAuth(): HeadersInit {
  return basic(DASHBOARD_USER, DASHBOARD_PASSWORD);
}

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
});

const CONFIG_ENV_KEYS = ["SPROUT_TRAEFIK_NETWORK", ...DASHBOARD_ENV_KEYS] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of CONFIG_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CONFIG_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("dashboard config", () => {
  test("disabled by default", () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    expect(loadConfig().dashboard).toEqual({
      enabled: false,
      user: "",
      password: "",
    });
  });

  test("parses truthy flag values", () => {
    for (const raw of ["1", "true", "yes", "on", " TRUE "]) {
      process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
      process.env.SPROUT_DASHBOARD_ENABLED = raw;
      process.env.SPROUT_DASHBOARD_USER = "op";
      process.env.SPROUT_DASHBOARD_PASSWORD = "pw";
      expect(loadConfig().dashboard.enabled).toBe(true);
      delete process.env.SPROUT_DASHBOARD_ENABLED;
    }
  });

  test("parses falsy flag values as disabled", () => {
    for (const raw of ["0", "false", "no", "off"]) {
      process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
      process.env.SPROUT_DASHBOARD_ENABLED = raw;
      expect(loadConfig().dashboard.enabled).toBe(false);
      delete process.env.SPROUT_DASHBOARD_ENABLED;
    }
  });

  test("rejects a non-boolean flag", () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    process.env.SPROUT_DASHBOARD_ENABLED = "sometimes";
    expect(() => loadConfig()).toThrow("Invalid SPROUT_DASHBOARD_ENABLED");
  });

  test("enabled without credentials fails naming the missing keys", () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    process.env.SPROUT_DASHBOARD_ENABLED = "true";
    expect(() => loadConfig()).toThrow(
      "Incomplete dashboard configuration: missing SPROUT_DASHBOARD_USER, SPROUT_DASHBOARD_PASSWORD",
    );
  });

  test("enabled with only a user names the missing password", () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    process.env.SPROUT_DASHBOARD_ENABLED = "1";
    process.env.SPROUT_DASHBOARD_USER = "op";
    expect(() => loadConfig()).toThrow(
      "Incomplete dashboard configuration: missing SPROUT_DASHBOARD_PASSWORD",
    );
  });

  test("enabled with credentials parses host and basic auth model", () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    process.env.SPROUT_DASHBOARD_ENABLED = "true";
    process.env.SPROUT_DASHBOARD_AUTH = "basic";
    process.env.SPROUT_DASHBOARD_USER = "op";
    process.env.SPROUT_DASHBOARD_PASSWORD = "pw";
    process.env.SPROUT_DASHBOARD_HOST = " dashboard.internal ";
    expect(loadConfig().dashboard).toEqual({
      enabled: true,
      host: "dashboard.internal",
      user: "op",
      password: "pw",
    });
  });

  test("rejects an unknown auth model", () => {
    process.env.SPROUT_TRAEFIK_NETWORK = "traefik";
    process.env.SPROUT_DASHBOARD_ENABLED = "true";
    process.env.SPROUT_DASHBOARD_AUTH = "session";
    process.env.SPROUT_DASHBOARD_USER = "op";
    process.env.SPROUT_DASHBOARD_PASSWORD = "pw";
    expect(() => loadConfig()).toThrow("Invalid SPROUT_DASHBOARD_AUTH");
  });
});

describe("GET /dashboard (flag off)", () => {
  test("no route or asset answers", async () => {
    testApp = await createTestApp();
    for (const path of ["/dashboard", "/dashboard/style.css", "/dashboard/app.js"]) {
      const res = await testApp.app.handle(
        new Request(`http://localhost${path}`, { headers: dashboardAuth() }),
      );
      expect(res.status).toBe(404);
    }
    const post = await testApp.app.handle(
      new Request("http://localhost/dashboard", {
        method: "POST",
        headers: dashboardAuth(),
      }),
    );
    expect(post.status).toBe(404);
  });
});

describe("GET /dashboard (flag on)", () => {
  test("unauthenticated requests get a Basic challenge", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    const res = await testApp.app.handle(
      new Request("http://localhost/dashboard"),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  test("wrong credentials and bearer tokens are rejected", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    for (const headers of [
      basic("operator", "wrong"),
      basic("intruder", DASHBOARD_PASSWORD),
      bearer(testApp.adminToken),
      { authorization: "Basic not-base64!!" },
    ]) {
      const res = await testApp.app.handle(
        new Request("http://localhost/dashboard", { headers }),
      );
      expect(res.status).toBe(401);
    }
  });

  test("authenticated renders every live preview in the list surface", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
    const token = body.token as string;
    for (const pr of [42, 43]) {
      const deployed = await postDeployAndSettle(testApp, token, {
        canonical_repo_id: "https://github.com/org/repo",
        pr_id: pr,
        slug: "myapp",
        hostname: `pr-${pr}.myapp.preview.example.com`,
        app_image: "myapp:latest",
      });
      expect(deployed.settleStatus).toBe(200);
    }

    const listed = await testApp.app.handle(
      new Request("http://localhost/v1/previews", {
        headers: bearer(testApp.adminToken),
      }),
    );
    const listedBody = (await listed.json()) as {
      previews: { pr_id: number }[];
    };

    const res = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("pr-42.myapp.preview.example.com");
    expect(html).toContain("pr-43.myapp.preview.example.com");
    expect(html).toContain("sprout_myapp_pr42");
    expect(html).toContain("https://github.com/org/repo/pull/42");
    const rendered = [...html.matchAll(/data-pr="(\d+)"/g)].map((m) => Number(m[1])).sort();
    expect(rendered).toEqual(
      listedBody.previews.map((p) => p.pr_id).sort(),
    );
  });

  test("links gitlab merge requests for gitlab repos", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: "https://gitlab.com/org/repo",
      slug: "glapp",
    });
    const deployed = await postDeployAndSettle(testApp, body.token as string, {
      canonical_repo_id: "https://gitlab.com/org/repo",
      pr_id: 7,
      slug: "glapp",
      hostname: "pr-7.glapp.preview.example.com",
      app_image: "glapp:latest",
    });
    expect(deployed.settleStatus).toBe(200);
    const res = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    expect(await res.text()).toContain(
      "https://gitlab.com/org/repo/-/merge_requests/7",
    );
  });

  test("rendered page leaks no write surface or credential material", async () => {
    testApp = await createTestApp({
      dashboard: { ...ENABLED },
      mail: {
        host: "mailpit",
        port: 1025,
        secure: false,
        fromDomain: "preview.invalid",
        uiUrl: "https://mail.example.com",
      },
    });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
    const deployToken = body.token as string;
    const deployed = await postDeployAndSettle(testApp, deployToken, {
      canonical_repo_id: "https://github.com/org/repo",
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
      app_image: "myapp:latest",
      mail: "enabled",
    });
    expect(deployed.settleStatus).toBe(200);

    const res = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    const html = await res.text();
    for (const forbidden of [
      "/v1/deploy",
      "/v1/teardown",
      "/v1/drop",
      "/v1/admin",
      "/v1/previews",
      "SPROUT_",
      testApp.adminToken,
      deployToken,
      DASHBOARD_PASSWORD,
      "preview-secret",
    ]) {
      expect(html.includes(forbidden), `leaks ${forbidden}`).toBe(false);
    }
    expect(html).toContain("mail.example.com");
  });

  test("only GET is reachable", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    const get = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    expect(get.status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await testApp.app.handle(
        new Request("http://localhost/dashboard", {
          method,
          headers: dashboardAuth(),
        }),
      );
      expect(res.status).not.toBe(200);
    }
  });

  test("request path performs no container inspection", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
    const deployed = await postDeployAndSettle(testApp, body.token as string, {
      canonical_repo_id: "https://github.com/org/repo",
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
      app_image: "myapp:latest",
    });
    expect(deployed.settleStatus).toBe(200);

    const previewDb = testApp.previewDb as unknown as Record<string, unknown>;
    for (const key of ["ping", "listPreviewDatabases"]) {
      previewDb[key] = async () => {
        throw new Error("must not inspect backends from the dashboard path");
      };
    }
    const docker = testApp.docker as unknown as Record<string, unknown>;
    docker["listPreviewContainers"] = async () => {
      throw new Error("must not inspect containers from the dashboard path");
    };

    const res = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pr-42.myapp.preview.example.com");
  });

  test("N previews cost one state query", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    await testApp.db.insert(previews).values([
      {
        canonicalRepoId: "https://github.com/org/repo",
        prId: 1,
        slug: "a",
        dbName: "sprout_a_pr1",
        hostname: "pr-1.a.preview.example.com",
        status: "running",
      },
      {
        canonicalRepoId: "https://github.com/org/repo",
        prId: 2,
        slug: "b",
        dbName: "sprout_b_pr2",
        hostname: "pr-2.b.preview.example.com",
        status: "failed",
        lastError: "preview_image_pull_failed",
        lastErrorDetail: "secret-detail-marker",
      },
      {
        canonicalRepoId: "https://github.com/org/repo",
        prId: 3,
        slug: "c",
        dbName: null,
        hostname: "pr-3.c.preview.example.com",
        status: "provisioning",
      },
    ]);

    let selects = 0;
    const counted = new Proxy(testApp.db, {
      get(target, prop, receiver) {
        if (prop === "select") selects += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const probe = createRoutes({
      db: counted as StateDb,
      previewDb: testApp.previewDb,
      app: bindTestPreviewApp(testApp.docker),
      dataVolumes: bindPreviewDataVolumes(testApp.docker),
      materialization: { traefikNetwork: "sprout-traefik" },
      dashboard: { ...ENABLED },
      telemetry: NO_TELEMETRY,
      governance: {
        previewTtlMs: null,
        previewIdleMs: null,
        maxPreviews: null,
        maxPreviewsPerRepo: null,
        previewMaxDbConnections: null,
        postgresMaxConnections: null,
      },
      legacyTtlMs: 72 * 3600_000,
    });
    const res = await probe.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    expect(res.status).toBe(200);
    expect(selects).toBe(1);
    const html = await res.text();
    expect(html).toContain("preview_image_pull_failed");
    expect(html.includes("secret-detail-marker")).toBe(false);
  });

  test("escapes stored values and ships no external assets", async () => {
    testApp = await createTestApp({ dashboard: { ...ENABLED } });
    await testApp.db.insert(previews).values({
      canonicalRepoId: "https://github.com/org/repo",
      prId: 9,
      slug: 'x"><script>alert(1)</script>',
      dbName: "sprout_x_pr9",
      hostname: "pr-9.x.preview.example.com",
      status: "running",
    });
    const res = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    const html = await res.text();
    expect(html.includes("<script>")).toBe(false);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('name="viewport"');
    expect(html.includes('<script src=')).toBe(false);
    expect(html.includes('rel="stylesheet"')).toBe(false);
  });

  test("dashboard host hides the page from other hosts", async () => {
    testApp = await createTestApp({
      dashboard: { ...ENABLED, host: "dashboard.internal" },
    });
    const elsewhere = await testApp.app.handle(
      new Request("http://localhost/dashboard", { headers: dashboardAuth() }),
    );
    expect(elsewhere.status).toBe(404);
    const home = await testApp.app.handle(
      new Request("http://dashboard.internal/dashboard", {
        headers: dashboardAuth(),
      }),
    );
    expect(home.status).toBe(200);
    const anonymous = await testApp.app.handle(
      new Request("http://dashboard.internal/dashboard"),
    );
    expect(anonymous.status).toBe(401);
  });
});
