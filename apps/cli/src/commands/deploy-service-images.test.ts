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

function okGateway() {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
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
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const BASE_ENV = {
  SPROUT_TOKEN: "t",
  GITHUB_REPOSITORY: "org/repo",
  GITHUB_REF: "refs/pull/9/merge",
};

async function runDeploy(opts: {
  yaml: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
}): Promise<{ code: number; images: string[] }> {
  const baseUrl = okGateway();
  const dir = await mkdtemp(join(tmpdir(), "sprout-cli-svc-img-"));
  await writeFile(join(dir, ".sprout.yaml"), opts.yaml);
  const deps: CliDeps = {
    cwd: dir,
    readTextFile: async (path) => Bun.file(path).text(),
    getGitRemoteUrl: () => null,
    createClient: (url, token) =>
      createApiClient(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { SPROUT_URL: baseUrl, ...BASE_ENV, ...opts.env },
  };
  const code = await runCli(["deploy", "-i", "app:1", ...(opts.args ?? [])], deps);
  const body = captured[0]?.body as { services?: { image: string }[] };
  return { code, images: (body?.services ?? []).map((s) => s.image) };
}

describe("service image placeholders", () => {
  test("placeholders resolve and the deploy body carries literals only", async () => {
    const { code, images } = await runDeploy({
      yaml: `
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:pr-{pr_id}-{hostname}"
      hostname: "landing-pr-{pr_id}.example.com"
`,
      env: { GITHUB_SHA: "deadbeef" },
    });
    expect(code).toBe(0);
    expect(images).toEqual([
      "registry.example.com/landing:pr-9-landing-pr-9.example.com",
    ]);
    const body = captured[0]?.body as {
      hostname?: string;
      services?: { image: string; hostname?: string; name: string }[];
    };
    const strings = [
      body.hostname ?? "",
      ...(body.services ?? []).flatMap((s) => [s.image, s.name, s.hostname ?? ""]),
    ];
    expect(strings.some((s) => s.includes("{") || s.includes("}"))).toBe(false);
  });

  test("--service overlay wins and its ref resolves", async () => {
    const { code, images } = await runDeploy({
      yaml: `
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:stale"
`,
      args: ["--service", "landing=registry.example.com/landing:pr-{pr_id}"],
    });
    expect(code).toBe(0);
    expect(images).toEqual(["registry.example.com/landing:pr-9"]);
  });

  test("unknown placeholder fails named before any HTTP call", async () => {
    const { code } = await runDeploy({
      yaml: `
slug: myapp
preview:
  hostname: "pr-{pr_id}.example.com"
  services:
    - name: landing
      image: "registry.example.com/landing:{nope}"
`,
    });
    expect(code).toBe(1);
    expect(stderr[0]).toBe(
      "preview.services[0].image: unknown placeholder {nope}",
    );
    expect(captured).toEqual([]);
  });
});
