import { opentelemetry } from "@elysiajs/opentelemetry";
import type { Attributes, Context, Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Config } from "../config.ts";
import { sproutVersion } from "./payload.ts";

export const TRACER_NAME = "sprout-gateway";

export function shouldTraceRequest(req: Request): boolean {
  try {
    return new URL(req.url).pathname !== "/healthz";
  } catch {
    return true;
  }
}

/**
 * Drops request bodies, headers and cookies at set time, on every span, for
 * every exporter. The framework plugin records them on the server span by
 * default; a trace backend is a second copy of whatever ends up in it, so
 * the values never reach the span object. Names stay, values do not.
 */
function isSensitiveAttributeKey(key: string): boolean {
  return (
    key.startsWith("http.request.header.") ||
    key === "http.request.body" ||
    key === "http.request.cookie"
  );
}

function redactAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = isSensitiveAttributeKey(key) ? "[redacted]" : value;
  }
  return out;
}

export class RedactingSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
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
  }

  onEnd(): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export type TracesHandle = {
  plugin: ReturnType<typeof opentelemetry> | undefined;
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
      new RedactingSpanProcessor(),
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
