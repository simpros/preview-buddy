import { afterEach, describe, expect, test } from "bun:test";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import {
  bearer,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

const PREVIEW_AUTH = {
  secret: "test-gateway-secret",
  address: "http://gateway:7331/v1/internal/preview-auth",
};

let testApp: TestApp | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakeDocker = undefined;
});

async function setup(withAuth: boolean) {
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
  });
  testApp = await createTestApp({
    docker: fakeDocker,
    ...(withAuth ? { previewAuth: PREVIEW_AUTH } : {}),
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

async function getAccess(
  token: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const query = new URLSearchParams({
    canonical_repo_id: REPO,
    pr_id: "42",
    ...params,
  }).toString();
  const res = await testApp!.app.handle(
    new Request(`http://localhost/v1/previews/access?${query}`, {
      headers: bearer(token),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function postRevoke(token: string) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/previews/access/revoke", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ canonical_repo_id: REPO, pr_id: 42 }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Drive the Traefik forwardAuth contract directly against the gateway. */
async function forwardAuth(input: {
  host: string;
  uri?: string;
  cookie?: string;
  basic?: string;
}): Promise<{ status: number; headers: Headers; body: unknown }> {
  const headers: Record<string, string> = {
    "x-forwarded-host": input.host,
    "x-forwarded-uri": input.uri ?? "/",
    "x-forwarded-method": "GET",
    "x-forwarded-proto": "https",
  };
  if (input.cookie) headers.cookie = input.cookie;
  if (input.basic) headers.authorization = `Basic ${input.basic}`;
  const res = await testApp!.app.handle(
    new Request("http://gateway:7331/v1/internal/preview-auth", { headers }),
  );
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

function basicHeader(user: string, password: string): string {
  return Buffer.from(`${user}:${password}`).toString("base64");
}

describe("preview.auth deploy gate", () => {
  test("link on a gateway without the capability fails the deploy", async () => {
    const { deployToken } = await setup(false);
    const res = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "link" }),
    );
    expect(res.settleStatus).toBe(500);
    expect(res.body).toEqual({
      error: "preview_auth_not_configured",
      detail: expect.stringContaining("SPROUT_PREVIEW_AUTH_SECRET"),
    });
  });

  test("unknown modes fail with a named error", async () => {
    const { deployToken } = await setup(true);
    const res = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "oidc" }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({
      error: "invalid_auth",
      detail: 'preview.auth must be none, basic, or link (got "oidc")',
    });
  });

  test("open previews keep byte-identical labels", async () => {
    const { deployToken } = await setup(true);
    const res = await postDeployAndSettle(testApp!, deployToken, deployBody());
    expect(res.outcome).toBe("ready");
    expect(fakeDocker!.creates[0]!.labels).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.sprout-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.sprout-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });
});

describe("preview.auth basic", () => {
  test("anonymous is 401, the documented credential is 200, and it survives redeploys", async () => {
    const { deployToken } = await setup(true);
    const first = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "basic" }),
    );
    expect(first.outcome).toBe("ready");
    const labels = fakeDocker!.creates[0]!.labels as Record<string, string>;
    expect(
      labels["traefik.http.routers.sprout-myapp-pr-42.middlewares"],
    ).toBe("sprout-myapp-pr-42-auth");
    const users =
      labels["traefik.http.middlewares.sprout-myapp-pr-42-auth.basicauth.users"];
    expect(users?.startsWith("sprout:$2y$")).toBe(true);

    const access = await getAccess(deployToken, {});
    expect(access.status).toBe(200);
    expect(access.body).toMatchObject({ auth: "basic", username: "sprout" });
    const password = access.body.password as string;
    expect(typeof password).toBe("string");

    const anon = await forwardAuth({ host: "pr-42.myapp.preview.example.com" });
    expect(anon.status).toBe(401);

    const authed = await forwardAuth({
      host: "pr-42.myapp.preview.example.com",
      basic: basicHeader("sprout", password),
    });
    expect(authed.status).toBe(200);

    const wrong = await forwardAuth({
      host: "pr-42.myapp.preview.example.com",
      basic: basicHeader("sprout", "wrong"),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ reason: "basic_rejected" });

    const second = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "basic" }),
    );
    expect(second.outcome).toBe("ready");
    const again = await getAccess(deployToken, {});
    expect(again.body.password).toBe(password);
  });
});

describe("preview.auth link", () => {
  test("fresh links set a host-scoped cookie; revoke kills them with no redeploy", async () => {
    const { deployToken } = await setup(true);
    const deployed = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "link" }),
    );
    expect(deployed.outcome).toBe("ready");
    const labels = fakeDocker!.creates[0]!.labels as Record<string, string>;
    expect(
      labels["traefik.http.middlewares.sprout-myapp-pr-42-auth.forwardauth.address"],
    ).toBe(PREVIEW_AUTH.address);
    expect(
      Object.keys(labels).some(
        (key) =>
          key.startsWith(
            "traefik.http.middlewares.sprout-myapp-pr-42-auth.",
          ) && key.includes("authResponseHeaders"),
      ),
    ).toBe(false);

    const host = "pr-42.myapp.preview.example.com";
    const anon = await forwardAuth({ host });
    expect(anon.status).toBe(401);

    const access = await getAccess(deployToken, {});
    expect(access.status).toBe(200);
    const url = access.body.url as string;
    expect(url.startsWith(`https://${host}/__sprout/auth?t=`)).toBe(true);
    const token = new URL(url).searchParams.get("t")!;

    const consume = await forwardAuth({
      host,
      uri: `/__sprout/auth?t=${token}`,
    });
    expect(consume.status).toBe(302);
    const setCookie = consume.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith("sprout_preview_auth=")).toBe(true);
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0]!;

    const authed = await forwardAuth({ host, cookie });
    expect(authed.status).toBe(200);

    const crossHost = await forwardAuth({
      host: "pr-43.myapp.preview.example.com",
      cookie,
    });
    expect(crossHost.status).toBe(401);

    const revoked = await postRevoke(deployToken);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revoked: true });

    const afterRevoke = await forwardAuth({ host, cookie });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body).toMatchObject({ reason: "revoked" });
    expect(fakeDocker!.creates.length).toBe(1);
  });

  test("past expiries fail on the next request", async () => {
    const { deployToken } = await setup(true);
    await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "link" }),
    );
    const host = "pr-42.myapp.preview.example.com";
    const access = await getAccess(deployToken, {
      expires: "2000-01-01T00:00:00Z",
    });
    expect(access.status).toBe(200);
    const token = new URL(access.body.url as string).searchParams.get("t")!;
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      const consume = await forwardAuth({
        host,
        uri: `/__sprout/auth?t=${token}`,
      });
      expect(consume.status).toBe(401);
      expect(consume.body).toMatchObject({ reason: "expired" });
    } finally {
      console.warn = origWarn;
    }
    expect(warned.some((line) => line.includes("reason=expired"))).toBe(true);
    expect(warned.some((line) => line.includes(token))).toBe(false);
    expect(
      warned.some((line) => line.includes(PREVIEW_AUTH.secret)),
    ).toBe(false);
  });

  test("custom expiries mint future links", async () => {
    const { deployToken } = await setup(true);
    await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "link" }),
    );
    const access = await getAccess(deployToken, { expires: "12h" });
    expect(access.status).toBe(200);
    expect(typeof access.body.expires_at).toBe("string");
    const bad = await getAccess(deployToken, { expires: "soon" });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({
      error: "invalid_expires",
      detail: "--expires must be like 30m, 12h, 7d, or an ISO date",
    });
  });
});

describe("preview.auth edges", () => {
  test("adopter labels cannot squat the gate middleware", async () => {
    const { deployToken } = await setup(true);
    const res = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({
        auth: "basic",
        labels: {
          "traefik.http.middlewares.sprout-myapp-pr-42-auth.basicauth.users":
            "evil",
        },
      }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({
      error: "reserved_preview_label",
      detail:
        "preview.labels.traefik.http.middlewares.sprout-myapp-pr-42-auth.basicauth.users collides with a gateway label",
    });
  });

  test("companion services are not double-gated", async () => {
    const { deployToken } = await setup(true);
    const res = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({
        auth: "link",
        services: [
          {
            name: "api",
            image: APP_IMAGE,
            hostname: "api-pr-42.myapp.preview.example.com",
          },
        ],
      }),
    );
    expect(res.outcome).toBe("ready");
    const svc = fakeDocker!.creates.find((c) =>
      c.name.includes("-svc-"),
    )!.labels as Record<string, string>;
    expect(
      Object.keys(svc).some((key) => key.includes("sprout-myapp-pr-42-auth")),
    ).toBe(false);
    expect(svc["traefik.enable"]).toBe("true");
  });

  test("switching modes replaces the gate; revoke on open previews fails cleanly", async () => {
    const { deployToken } = await setup(true);
    const gated = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody({ auth: "basic" }),
    );
    expect(gated.outcome).toBe("ready");
    const opened = await postDeployAndSettle(
      testApp!,
      deployToken,
      deployBody(),
    );
    expect(opened.outcome).toBe("ready");
    const apps = fakeDocker!.creates.filter(
      (c) => c.name === "sprout-myapp-pr-42",
    );
    const labels = apps[apps.length - 1]!.labels as Record<string, string>;
    expect(
      Object.keys(labels).some((key) => key.includes("-auth.basicauth")),
    ).toBe(false);
    const revoked = await postRevoke(deployToken);
    expect(revoked.status).toBe(422);
    expect(revoked.body).toEqual({ error: "access_not_gated" });
  });
});
