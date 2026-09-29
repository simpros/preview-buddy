import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";

type Captured = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let captured: Captured[] = [];
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  captured = [];
  stdout = [];
  stderr = [];
});

function startGateway(
  handler: (req: Request, url: URL) => Response | Promise<Response>,
) {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      return handler(req, url);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function withWorkspace(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sprout-cli-svc-img-"));
  await writeFile(join(dir, ".sprout.yaml"), yaml);
  return dir;
}

function deps(
  overrides: Partial<CliDeps> & { env: NodeJS.ProcessEnv },
): CliDeps {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    readTextFile: overrides.readTextFile ?? (async () => null),
    getGitRemoteUrl: overrides.getGitRemoteUrl ?? (() => null),
    createClient:
      overrides.createClient ??
      ((baseUrl, token) =>
        createApiClient(baseUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })),
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    ...overrides,
  };
}

function okGateway() {
  return startGateway(async (req, url) => {
    captured.push({
      method: req.method,
      path: url.pathname,
      body: await req.json(),
      authorization: req.headers.get("authorization"),
    });
    return Response.json({
      ok: true,
      status: "running",
      preview_url: "https://pr-9.example.com",
    });
  });
}

function bodyHasBrace(): boolean {
  const body = captured[0]?.body as {
    hostname?: string;
    app_image?: string;
    services?: { image: string; hostname?: string; name: string }[];
  };
  const strings: string[] = [];
  if (typeof body.hostname === "string") strings.push(body.hostname);
  if (typeof body.app_image === "string") strings.push(body.app_image);
  for (const s of body.services ?? []) {
    strings.push(s.image, s.name);
    if (s.hostname) strings.push(s.hostname);
  }
  return strings.some((s) => s.includes("{") || s.includes("}"));
}

function bodyImages(): string[] {
  const body = captured[0]?.body as { services?: { image: string }[] };
  return (body.services ?? []).map((s) => s.image);
}

function expectLiteralBody() {
  expect(bodyHasBrace()).toBe(false);
}

describe("service image placeholders", () => {
  test("{commit_sha} resolves under GITHUB_SHA", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:{commit_sha}"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
          GITHUB_SHA: "deadbeef",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(bodyImages()).toEqual(["registry.example.com/landing:deadbeef"]);
    expectLiteralBody();
  });

  test("{commit_sha} resolves under CI_COMMIT_SHA", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:{commit_sha}"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          CI_PROJECT_URL: "https://gitlab.com/group/repo",
          CI_MERGE_REQUEST_IID: "9",
          CI_COMMIT_SHA: "cafef00d",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(bodyImages()).toEqual(["registry.example.com/landing:cafef00d"]);
    expectLiteralBody();
  });

  test("{pr_id} and {hostname} resolve; service hostname wins over app hostname", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:pr-{pr_id}-{hostname}"
      hostname: "landing-pr-{pr_id}.example.com"
    - name: plain
      image: "registry.example.com/plain:{hostname}"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(bodyImages()).toEqual([
      "registry.example.com/landing:pr-9-landing-pr-9.example.com",
      "registry.example.com/plain:pr-9.example.com",
    ]);
    expectLiteralBody();
  });

  test("literal refs stay byte-identical", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: api
      image: "ghcr.io/org/api:1.2.3"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(bodyImages()).toEqual(["ghcr.io/org/api:1.2.3"]);
  });

  test("unknown placeholder fails named before any HTTP call", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: ok
      image: "img:1"
    - name: landing
      image: "registry.example.com/landing:{foo}"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "preview.services[1].image: unknown placeholder {foo}",
    );
    expect(captured).toEqual([]);
  });

  test("missing SHA fails named before any HTTP call", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: ok
      image: "img:1"
    - name: landing
      image: "registry.example.com/landing:{commit_sha}"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "preview.services[1].image: {commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA",
    );
    expect(captured).toEqual([]);
  });

  test("--service overlay wins and its ref resolves", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:stale"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1", "--service", "landing=registry.example.com/landing:pr-{pr_id}"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(0);
    expect(bodyImages()).toEqual(["registry.example.com/landing:pr-9"]);
    expectLiteralBody();
  });

  test("--service placeholder error fails named before any HTTP call", async () => {
    const baseUrl = okGateway();
    const cwd = await withWorkspace(`
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
`);
    const code = await runCli(
      ["deploy", "-i", "app:1", "--service", "landing=registry.example.com/landing:{nope}"],
      deps({
        cwd,
        env: {
          SPROUT_URL: baseUrl,
          SPROUT_TOKEN: "t",
          GITHUB_REPOSITORY: "org/repo",
          GITHUB_REF: "refs/pull/9/merge",
        },
        readTextFile: async (path) => Bun.file(path).text(),
      }),
    );
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "preview.services[0].image: unknown placeholder {nope}",
    );
    expect(captured).toEqual([]);
  });
});
