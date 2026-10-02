import { opentelemetry } from "@elysiajs/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
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
 * This wraps the exporter rather than running as a span processor: export is
 * structurally the last touch before serialization, so the guarantee cannot
 * be broken by reordering span processors. It also covers creation-time
 * attributes, which never pass through setAttribute.
 */
function isSensitiveAttributeKey(key: string): boolean {
  return /^http\.(request|response)\.(header\.|body$|cookie$)/.test(key);
}

function scrubSpanAttributes(span: ReadableSpan): void {
  for (const key of Object.keys(span.attributes)) {
    if (isSensitiveAttributeKey(key)) {
      span.attributes[key] = "[redacted]";
    }
  }
}

export function createRedactingExporter(inner: SpanExporter): SpanExporter {
  return {
    export(spans, resultCallback): void {
      for (const span of spans) scrubSpanAttributes(span);
      inner.export(spans, resultCallback);
    },

    async shutdown(): Promise<void> {
      await inner.shutdown();
    },

    async forceFlush(): Promise<void> {
      await inner.forceFlush?.();
    },
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
      new BatchSpanProcessor(createRedactingExporter(exporter)),
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
