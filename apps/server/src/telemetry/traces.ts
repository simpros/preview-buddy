import { opentelemetry } from "@elysiajs/opentelemetry";
import type { Attributes, Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Config } from "../config.ts";
import { TRACER_NAME } from "./tracer-name.ts";
import { sproutVersion } from "./payload.ts";

export { TRACER_NAME };

export function shouldTraceRequest(req: Request): boolean {
  try {
    return new URL(req.url).pathname !== "/healthz";
  } catch {
    return true;
  }
}

/**
 * Drops request/response bodies, headers and cookies at set time, on every
 * span, for every exporter. The framework plugin records them on the server
 * span by default; a trace backend is a second copy of whatever ends up in
 * it, so the values never reach the span object. Names stay, values do not.
 *
 * This only covers attributes set after span creation: the SDK applies
 * creation-time attributes before onStart runs, so never pass sensitive
 * values via startSpan options — set them (or rather, don't) afterwards.
 */
function isSensitiveAttributeKey(key: string): boolean {
  return /^http\.(request|response)\.(header\.|body$|cookie$)/.test(key);
}

function redactAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = isSensitiveAttributeKey(key) ? "[redacted]" : value;
  }
  return out;
}

export function createRedactingSpanProcessor(): SpanProcessor {
  return {
    onStart(span: Span): void {
      const setAttribute = span.setAttribute.bind(span);
      span.setAttribute = ((key: string, value: unknown) => {
        if (isSensitiveAttributeKey(key)) {
          return setAttribute(key, "[redacted]");
        }
        return setAttribute(key, value as never);
      }) as typeof span.setAttribute;
      const setAttributes = span.setAttributes.bind(span);
      span.setAttributes = ((attributes: Attributes) => {
        return setAttributes(redactAttributes(attributes));
      }) as typeof span.setAttributes;
    },

    onEnd(): void {},
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
