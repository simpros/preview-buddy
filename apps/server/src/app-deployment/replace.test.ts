import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import {
  preparePreviewImage,
  removePreviewApp,
  replacePreviewApp,
} from "./replace.ts";

const baseDeps = {
  pg: {
    host: "postgres",
    port: 5432,
    user: "pb_preview",
    password: "sekrit",
  },
  networks: {
    traefik: "preview-buddy-traefik",
    postgres: "preview-buddy-postgres",
  },
};

describe("preparePreviewImage", () => {
  test("pulls and returns EXPOSE port", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/app:sha": 3000 },
    });
    const port = await preparePreviewImage(
      docker,
      "ghcr.io/org/app:sha",
      8080,
    );
    expect(port).toBe(3000);
    expect(docker.pulls).toEqual(["ghcr.io/org/app:sha"]);
  });

  test("falls back to default when image has no EXPOSE", async () => {
    const docker = createFakeDockerClient();
    const port = await preparePreviewImage(
      docker,
      "ghcr.io/org/app:noexpose",
      8080,
    );
    expect(port).toBe(8080);
  });
});

describe("removePreviewApp", () => {
  test("removes the stable preview container name", async () => {
    const docker = createFakeDockerClient();
    await removePreviewApp(docker, "myapp", 42);
    expect(docker.removed).toEqual(["pb-myapp-pr-42"]);
  });
});

describe("replacePreviewApp", () => {
  test("removes prior container, creates with PG* env, dual networks, Traefik labels", async () => {
    const docker = createFakeDockerClient();

    const result = await replacePreviewApp(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        dbName: "prev_myapp_pr42",
        port: 3000,
      },
    );

    expect(result).toEqual({ containerId: "fake-1", port: 3000 });
    expect(docker.pulls).toEqual([]);
    expect(docker.removed).toEqual(["pb-myapp-pr-42"]);
    expect(docker.creates).toHaveLength(1);
    const created = docker.creates[0]!;
    expect(created.name).toBe("pb-myapp-pr-42");
    expect(created.image).toBe("ghcr.io/org/app:sha");
    expect(created.env).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=pb_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
    ]);
    expect(created.networkNames).toEqual([
      "preview-buddy-traefik",
      "preview-buddy-postgres",
    ]);
    expect(created.labels).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.pb-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.pb-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });

  test("uses caller-provided port for Traefik labels", async () => {
    const docker = createFakeDockerClient();
    const result = await replacePreviewApp(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 7,
        hostname: "pr-7.example.com",
        image: "ghcr.io/org/app:noexpose",
        dbName: "prev_myapp_pr7",
        port: 8080,
      },
    );
    expect(result.port).toBe(8080);
    expect(
      docker.creates[0]!.labels[
        "traefik.http.services.pb-myapp-pr-7.loadbalancer.server.port"
      ],
    ).toBe("8080");
  });

  test("replace removes then creates again under the same name", async () => {
    const docker = createFakeDockerClient();
    const input = {
      slug: "widgets",
      prId: 3,
      hostname: "pr-3.widgets.example.com",
      dbName: "prev_widgets_pr3",
      port: 80,
    };
    await replacePreviewApp(
      { docker, ...baseDeps },
      { ...input, image: "img:v1" },
    );
    await replacePreviewApp(
      { docker, ...baseDeps },
      { ...input, image: "img:v2" },
    );
    expect(docker.removed).toEqual(["pb-widgets-pr-3", "pb-widgets-pr-3"]);
    expect(docker.creates.map((c) => c.image)).toEqual(["img:v1", "img:v2"]);
    expect(docker.running.get("pb-widgets-pr-3")?.spec.image).toBe("img:v2");
  });
});
