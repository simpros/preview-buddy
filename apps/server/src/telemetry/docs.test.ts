import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEPLOY_FAILED_EVENT_KEYS,
  DEPLOY_SUCCESS_EVENT_KEYS,
  INSTALL_EVENT_KEYS,
  sproutVersion,
  TELEMETRY_CAPABILITY_VOCABULARY,
} from "./payload.ts";

/**
 * Every JSON sample in docs/telemetry.md is a payload this module builds:
 * the key sets are asserted exactly, versioned fields against the live
 * values, illustrative fields for shape only.
 */

const KEY_SETS = [
  [...INSTALL_EVENT_KEYS].sort(),
  [...DEPLOY_SUCCESS_EVENT_KEYS].sort(),
  [...DEPLOY_FAILED_EVENT_KEYS].sort(),
];

function docsSamples(): unknown[] {
  const text = readFileSync(
    join(import.meta.dir, "../../../../docs/telemetry.md"),
    "utf8",
  );
  const samples: unknown[] = [];
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    samples.push(JSON.parse(match[1]!));
  }
  return samples;
}

describe("telemetry docs samples", () => {
  test("each sample matches an asserted payload shape", () => {
    const samples = docsSamples();
    expect(samples.length).toBe(3);
    const vocab = new Set<string>(TELEMETRY_CAPABILITY_VOCABULARY);
    for (const sample of samples) {
      const event = sample as Record<string, unknown>;
      expect(KEY_SETS).toContainEqual([...Object.keys(event)].sort());
      expect(event.sprout_version).toBe(sproutVersion());
      expect(String(event.runtime)).toMatch(/^bun \S+/);
      expect(String(event.platform)).toMatch(/^[a-z0-9]+\/[a-z0-9]+$/);
      expect(Array.isArray(event.capabilities)).toBe(true);
      for (const capability of event.capabilities as string[]) {
        expect(vocab.has(capability)).toBe(true);
      }
      expect(Number.isNaN(Date.parse(String(event._timestamp)))).toBe(false);
      if (event.event === "deploy") {
        expect(["running", "failed"]).toContain(event.outcome);
        expect([
          "full_replace",
          "seed_resume",
          "sync_close",
          "close",
        ]).toContain(event.plan);
        if (event.outcome === "failed") {
          expect(typeof event.failure_class).toBe("string");
          expect("failure_family" in event).toBe(true);
        } else {
          expect("failure_class" in event).toBe(false);
          expect("failure_family" in event).toBe(false);
        }
      } else {
        expect(event.event).toBe("install");
        expect(typeof event.previews_total).toBe("number");
        expect(typeof event.deploys_total).toBe("number");
      }
    }
    const kinds = samples.map((s) => (s as { event: string }).event).sort();
    expect(kinds).toEqual(["deploy", "deploy", "install"]);
  });
});
