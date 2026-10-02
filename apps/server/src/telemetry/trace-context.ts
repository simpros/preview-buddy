import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@opentelemetry/api";

/**
 * Carries the deploy span's context across awaits the OTel context manager
 * drops. The manager loses the active span on yielded continuations under
 * this runtime while node:async_hooks keeps it, so the deploy root binds
 * its context here once and phase spans read it back as an explicit parent.
 */
const storage = new AsyncLocalStorage<Context>();

export function runWithTraceContext<T>(ctx: Context, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function ambientTraceContext(): Context | undefined {
  return storage.getStore();
}
