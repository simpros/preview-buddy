import { describe, expect, test } from "bun:test";
import { tryWithPreviewLock, withPreviewLock } from "./locks.ts";

describe("per-preview lock", () => {
  test("try-lock skips when a deploy holds the lock", async () => {
    const order: string[] = [];
    await withPreviewLock("repo", 1, async () => {
      order.push("deploy-start");
      const attempt = await tryWithPreviewLock("repo", 1, async () => {
        order.push("sweep-ran");
        return true;
      });
      expect(attempt.acquired).toBe(false);
      order.push("deploy-end");
    });
    expect(order).toEqual(["deploy-start", "deploy-end"]);
  });

  test("try-lock acquires when free", async () => {
    const attempt = await tryWithPreviewLock("repo", 2, async () => 42);
    expect(attempt).toEqual({ acquired: true, value: 42 });
  });
});
