import { afterEach, describe, expect, jest, test } from "bun:test";
import { startSweepTimer } from "./timer.ts";

const MINUTE_MS = 60_000;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function freezeClock(): void {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
}

afterEach(() => {
  jest.useRealTimers();
});

describe("startSweepTimer", () => {
  test("runs no pass at boot; first pass lands on the first boundary", async () => {
    freezeClock();
    let passes = 0;
    const handle = startSweepTimer({
      schedule: "* * * * *",
      runPass: async () => {
        passes += 1;
      },
    });

    await flush();
    expect(passes).toBe(0);

    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(passes).toBe(1);

    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(passes).toBe(2);

    handle.stop();
  });

  test("keeps one pass in flight at a time", async () => {
    freezeClock();
    let starts = 0;
    let release!: () => void;
    let gated = true;
    const handle = startSweepTimer({
      schedule: "* * * * *",
      runPass: async () => {
        starts += 1;
        if (gated) await new Promise<void>((resolve) => { release = resolve; });
      },
    });

    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(starts).toBe(1);

    jest.advanceTimersByTime(5 * MINUTE_MS);
    await flush();
    expect(starts).toBe(1);

    gated = false;
    release();
    await flush();
    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(starts).toBe(2);

    handle.stop();
  });

  test("routes pass errors to onError and keeps the schedule", async () => {
    freezeClock();
    let calls = 0;
    const errors: unknown[] = [];
    const handle = startSweepTimer({
      schedule: "* * * * *",
      runPass: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("boom");

    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);

    handle.stop();
  });

  test("stop prevents any further pass", async () => {
    freezeClock();
    let passes = 0;
    const handle = startSweepTimer({
      schedule: "* * * * *",
      runPass: async () => {
        passes += 1;
      },
    });

    jest.advanceTimersByTime(MINUTE_MS);
    await flush();
    expect(passes).toBe(1);

    handle.stop();
    jest.advanceTimersByTime(10 * MINUTE_MS);
    await flush();
    expect(passes).toBe(1);
  });
});
