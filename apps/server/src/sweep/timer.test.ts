import { describe, expect, test } from "bun:test";
import { startSweepTimer } from "./timer.ts";

type TimerFn = (...args: unknown[]) => void;

describe("startSweepTimer", () => {
  test("waits one full interval before the first pass, then repeats", async () => {
    const calls: number[] = [];
    const timeouts: Array<{ ms: number; fn: TimerFn }> = [];
    const intervals: Array<{ ms: number; fn: TimerFn }> = [];

    const handle = startSweepTimer({
      intervalMs: 30_000,
      runPass: async () => {
        calls.push(Date.now());
      },
      setTimeout: ((fn: TimerFn, ms: number) => {
        timeouts.push({ ms, fn });
        return 1;
      }) as unknown as typeof setTimeout,
      setInterval: ((fn: TimerFn, ms: number) => {
        intervals.push({ ms, fn });
        return 2;
      }) as unknown as typeof setInterval,
      clearTimeout: (() => {}) as typeof clearTimeout,
      clearInterval: (() => {}) as typeof clearInterval,
    });

    expect(calls).toEqual([]);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.ms).toBe(30_000);
    expect(intervals).toHaveLength(0);

    await timeouts[0]!.fn();
    expect(calls).toHaveLength(1);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(30_000);

    await intervals[0]!.fn();
    expect(calls).toHaveLength(2);

    handle.stop();
  });

  test("stop prevents the delayed first pass from running", async () => {
    const calls: number[] = [];
    let timeoutFn: TimerFn | undefined;

    const handle = startSweepTimer({
      intervalMs: 1_000,
      runPass: async () => {
        calls.push(1);
      },
      setTimeout: ((fn: TimerFn) => {
        timeoutFn = fn;
        return 1;
      }) as unknown as typeof setTimeout,
      setInterval: (() => 2) as unknown as typeof setInterval,
      clearTimeout: (() => {
        timeoutFn = undefined;
      }) as typeof clearTimeout,
      clearInterval: (() => {}) as typeof clearInterval,
    });

    handle.stop();
    expect(timeoutFn).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("skips a tick while a previous pass is still in flight", async () => {
    let resolvePass: (() => void) | undefined;
    const started: Array<() => void> = [];
    const waitStarted = () =>
      new Promise<void>((resolve) => {
        started.push(resolve);
      });
    let startCount = 0;
    const intervals: Array<{ fn: TimerFn }> = [];

    const handle = startSweepTimer({
      intervalMs: 1_000,
      runPass: async () => {
        startCount += 1;
        started.shift()?.();
        await new Promise<void>((resolve) => {
          resolvePass = resolve;
        });
      },
      setTimeout: ((fn: TimerFn) => {
        queueMicrotask(() => fn());
        return 1;
      }) as unknown as typeof setTimeout,
      setInterval: ((fn: TimerFn) => {
        intervals.push({ fn });
        return 2;
      }) as unknown as typeof setInterval,
      clearTimeout: (() => {}) as typeof clearTimeout,
      clearInterval: (() => {}) as typeof clearInterval,
    });

    await waitStarted();
    expect(startCount).toBe(1);
    expect(intervals).toHaveLength(1);

    void intervals[0]!.fn();
    await Promise.resolve();
    expect(startCount).toBe(1);

    resolvePass!();
    await Promise.resolve();
    await Promise.resolve();

    const second = waitStarted();
    void intervals[0]!.fn();
    await second;
    expect(startCount).toBe(2);

    resolvePass!();
    handle.stop();
  });
});
