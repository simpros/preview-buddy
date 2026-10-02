import { afterEach, describe, expect, test } from "bun:test";
import { createApiClient } from "@sprout/api-client";
import { runCli, type CliDeps } from "../run.ts";
import { formatAccess, formatRevoked } from "./access.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
let stdout: string[] = [];
let stderr: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
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

describe("sprout access", () => {
  test("prints the shareable link with default expiry", async () => {
    const seen: string[] = [];
    const baseUrl = startGateway(async (req, url) => {
      seen.push(`${req.method} ${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname === "/v1/previews/access") {
        return Response.json({
          ok: true,
          auth: "link",
          url: "https://pr-42.example.com/__sprout/auth?t=tok",
          expires_at: "2026-10-09T00:00:00.000Z",
          hostname: "pr-42.example.com",
        });
      }
      return new Response("no", { status: 404 });
    });
    const code = await runCli(
      ["access", "42", "--repo", "https://github.com/org/repo"],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t" } }),
    );
    expect(code).toBe(0);
    expect(seen).toEqual([
      "GET /v1/previews/access?canonical_repo_id=https%3A%2F%2Fgithub.com%2Forg%2Frepo&pr_id=42",
    ]);
    expect(stdout).toEqual([
      "Shareable link (expires 2026-10-09T00:00:00.000Z):\nhttps://pr-42.example.com/__sprout/auth?t=tok",
    ]);
  });

  test("revoke posts and prints the no-redeploy note for links", async () => {
    const baseUrl = startGateway(async (req, url) => {
      if (
        url.pathname === "/v1/previews/access/revoke" &&
        req.method === "POST"
      ) {
        return Response.json({ ok: true, auth: "link", revoked: true });
      }
      return new Response("no", { status: 404 });
    });
    const code = await runCli(
      ["access", "42", "--revoke", "--repo", "https://github.com/org/repo"],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t" } }),
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(["Outstanding links revoked with no redeploy."]);
  });

  test("rejects revoke combined with expires", async () => {
    const baseUrl = startGateway(async () => new Response("no", { status: 404 }));
    const code = await runCli(
      [
        "access",
        "42",
        "--revoke",
        "--expires",
        "1h",
        "--repo",
        "https://github.com/org/repo",
      ],
      deps({ env: { SPROUT_URL: baseUrl, SPROUT_TOKEN: "t" } }),
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["--revoke cannot be combined with --expires"]);
  });

  test("formats basic credentials and the open preview", () => {
    expect(
      formatAccess({
        ok: true,
        auth: "basic",
        username: "sprout",
        password: "pw",
        hostname: "pr-42.example.com",
      }),
    ).toBe(
      "Preview is gated with basic auth:\nURL: https://pr-42.example.com\nUsername: sprout\nPassword: pw",
    );
    expect(
      formatAccess({
        ok: true,
        auth: "none",
        hostname: "pr-42.example.com",
        preview_url: "https://pr-42.example.com",
      }),
    ).toContain("preview.auth is none");
    expect(
      formatRevoked({ ok: true, auth: "basic", revoked: true, relabel_required: true }),
    ).toContain("next deploy");
  });
});
