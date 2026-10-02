import { describe, expect, test } from "bun:test";
import { parseBringUpPlan } from "./bring-up.ts";

describe("parseBringUpPlan", () => {
  test("unknown plans fall back to full_replace", () => {
    expect(parseBringUpPlan(null)).toBe("full_replace");
    expect(parseBringUpPlan("sync_close")).toBe("sync_close");
    expect(parseBringUpPlan("injected-plan")).toBe("full_replace");
  });
});
