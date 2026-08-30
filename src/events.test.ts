import { describe, expect, test } from "bun:test";
import {
  normalizeGitHubPayload,
  normalizeGitLabPayload,
} from "../src/events.ts";

describe("normalizeGitHubPayload", () => {
  test("opened pull_request", () => {
    const event = normalizeGitHubPayload({
      action: "opened",
      pull_request: { number: 42 },
      repository: { full_name: "org/repo" },
    });
    expect(event).toEqual({
      action: "opened",
      prId: 42,
      repo: "org/repo",
    });
  });

  test("closed pull_request", () => {
    const event = normalizeGitHubPayload({
      action: "closed",
      pull_request: { number: 7 },
      repository: { full_name: "org/repo" },
    });
    expect(event?.action).toBe("closed");
  });

  test("ignores synchronize", () => {
    const event = normalizeGitHubPayload({
      action: "synchronize",
      pull_request: { number: 1 },
      repository: { full_name: "org/repo" },
    });
    expect(event).toBeNull();
  });

  test("returns null for invalid payload", () => {
    expect(normalizeGitHubPayload(null)).toBeNull();
    expect(normalizeGitHubPayload({ action: "opened" })).toBeNull();
  });
});

describe("normalizeGitLabPayload", () => {
  test("open merge_request", () => {
    const event = normalizeGitLabPayload({
      object_attributes: { action: "open", iid: 99 },
      project: { path_with_namespace: "group/project" },
    });
    expect(event).toEqual({
      action: "opened",
      prId: 99,
      repo: "group/project",
    });
  });

  test("close merge_request", () => {
    const event = normalizeGitLabPayload({
      object_attributes: { action: "close", iid: 3 },
      project: { path_with_namespace: "group/project" },
    });
    expect(event?.action).toBe("closed");
  });

  test("merge maps to closed", () => {
    const event = normalizeGitLabPayload({
      object_attributes: { action: "merge", iid: 3 },
      project: { path_with_namespace: "group/project" },
    });
    expect(event?.action).toBe("closed");
  });

  test("ignores update (synchronize-like)", () => {
    const event = normalizeGitLabPayload({
      object_attributes: { action: "update", iid: 1 },
      project: { path_with_namespace: "group/project" },
    });
    expect(event).toBeNull();
  });
});
