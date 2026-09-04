import { describe, expect, test } from "bun:test";
import { previewContainerName } from "../preview/naming.ts";
import { createDockerRemover } from "./docker-remover.ts";

describe("createDockerRemover", () => {
  test("lists preview containers from Docker catalog", async () => {
    const remover = createDockerRemover({
      fetch: async (input) => {
        expect(String(input)).toContain("/containers/json?");
        expect(String(input)).toContain("all=true");
        return new Response(
          JSON.stringify([
            { Id: "id-7", Names: ["/pb-widgets-pr-7"] },
            { Id: "id-other", Names: ["/unrelated"] },
            { Id: "id-8", Names: ["/pb-widgets-pr-8", "/alias"] },
          ]),
          { status: 200 },
        );
      },
    });

    expect(await remover.listPreviewContainers()).toEqual([
      {
        containerId: "id-7",
        containerName: "pb-widgets-pr-7",
        slug: "widgets",
        prId: 7,
      },
      {
        containerId: "id-8",
        containerName: "pb-widgets-pr-8",
        slug: "widgets",
        prId: 8,
      },
    ]);
  });

  test("removes by container id then always attempts deterministic name", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });

    await remover.remove({ containerId: "abc123", slug: "widgets", prId: 7 });
    expect(calls).toEqual([
      "http://localhost/containers/abc123?force=true",
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("falls back to preview container name when containerId is null", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 404 });
      },
    });

    await remover.remove({ containerId: null, slug: "widgets", prId: 7 });
    expect(calls).toEqual([
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("attempts deterministic name after containerId 404", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 404 });
      },
    });

    await remover.remove({ containerId: "stale-id", slug: "widgets", prId: 7 });
    expect(calls).toEqual([
      "http://localhost/containers/stale-id?force=true",
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("succeeds when containerId hard-fails but deterministic name returns 204", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/containers/stale-id?")) {
          return new Response("engine error", { status: 500 });
        }
        return new Response(null, { status: 204 });
      },
    });

    await remover.remove({ containerId: "stale-id", slug: "widgets", prId: 7 });
    expect(calls).toEqual([
      "http://localhost/containers/stale-id?force=true",
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("rejects when containerId is 404 but deterministic name hard-fails", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/containers/stale-id?")) {
          return new Response(null, { status: 404 });
        }
        return new Response("engine error", { status: 500 });
      },
    });

    await expect(
      remover.remove({ containerId: "stale-id", slug: "widgets", prId: 7 }),
    ).rejects.toThrow(/Docker remove .* failed: 500/);
    expect(calls).toEqual([
      "http://localhost/containers/stale-id?force=true",
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });
});
