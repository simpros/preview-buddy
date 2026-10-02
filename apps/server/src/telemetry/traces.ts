import { opentelemetry } from "@elysiajs/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Config } from "../config.ts";
import { TRACER_NAME } from "./tracer-name.ts";
import { sproutVersion } from "./payload.ts";

export function shouldTraceRequest(req: Request): boolean {
  try {
    return new URL(req.url).pathname !== "/healthz";
  } catch {
    return true;
  }
}

/**
 * Drops request/response bodies, headers and cookies at export time, on every
 * span, for every exporter. The framework plugin records them on the server
 * span by default; a trace backend is a second copy of whatever ends up in
 * it, so the values are scrubbed before the batch processor sees them.
 * Names stay, values do not.
 *
 * This runs in onEnd rather than by intercepting setAttribute: creation-time
 * attributes never pass through setAttribute, and the scrubbed span is what
 * the exporter buffers because this processor is registered first.
 */
function isSensitiveAttributeKey(key: string): boolean {
  return /^http\.(request|response)\.(header\.|body$|cookie$)/.test(key);
}

export function createRedactingSpanProcessor(): SpanProcessor {
  return {
    onStart(): void {},

    onEnd(span: ReadableSpan): void {
      for (const key of Object.keys(span.attributes)) {
        if (isSensitiveAttributeKey(key)) {
          span.attributes[key] = "[redacted]";
        }
      }
    },

    async shutdown(): Promise<void> {},
    async forceFlush(): Promise<void> {},
  };
}

export type TracesHandle = {
  plugin: ReturnType<typeof opentelemetry> | undefined;
  /**
   * Flushes the exporter. Production never calls it (no signal handling, by
   * design — a dying gateway drops its batch); tests use it to await export.
   */
  shutdown: () => Promise<void>;
};

export function createTraces(config: Config): TracesHandle {
  const endpoint = config.otlp.endpoint;
  if (endpoint === "") {
    return { plugin: undefined, shutdown: async () => {} };
  }
  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: config.otlp.headers,
  });
  const sdk = new NodeSDK({
    serviceName: TRACER_NAME,
    resource: resourceFromAttributes({
      "service.version": sproutVersion(),
    }),
    spanProcessors: [
      createRedactingSpanProcessor(),
      new BatchSpanProcessor(exporter),
    ],
  });
  sdk.start();
  const plugin = opentelemetry({
    serviceName: TRACER_NAME,
    checkIfShouldTrace: shouldTraceRequest,
  });
  return {
    plugin,
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } catch {
      }
    },
  };
}
