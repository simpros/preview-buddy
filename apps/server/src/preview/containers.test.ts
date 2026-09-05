import { describe, expect, test } from "bun:test";
import { createDockerRemover } from "./containers.ts";
import { previewContainerName } from "./naming.ts";

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

  test("removes by deterministic preview container name", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });

    await remover.remove({ slug: "widgets", prId: 7 });
    expect(calls).toEqual([
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("treats 404 as success when container is already gone", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 404 });
      },
    });

    await remover.remove({ slug: "widgets", prId: 7 });
    expect(calls).toEqual([
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });

  test("rejects when deterministic name hard-fails", async () => {
    const calls: string[] = [];
    const remover = createDockerRemover({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("engine error", { status: 500 });
      },
    });

    await expect(remover.remove({ slug: "widgets", prId: 7 })).rejects.toThrow(
      /Docker remove .* failed: 500/,
    );
    expect(calls).toEqual([
      `http://localhost/containers/${previewContainerName("widgets", 7)}?force=true`,
    ]);
  });
});
