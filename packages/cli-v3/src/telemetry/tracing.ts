import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { Resource, detectResourcesSync, processDetectorSync } from "@opentelemetry/resources";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import * as packageJson from "../../package.json";

function initializeTracing(): NodeTracerProvider | undefined {
  if (process.argv.includes("--skip-telemetry") || process.env.TRIGGER_DEV_SKIP_TELEMETRY) {
    return;
  }

  if (process.env.OTEL_INTERNAL_DIAG_DEBUG) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = detectResourcesSync({
    detectors: [processDetectorSync],
  }).merge(
    new Resource({
      service: "trigger.dev cli v3",
    })
  );

  const traceProvider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 500,
    resource,
    spanLimits: {
      attributeCountLimit: 1000,
      attributeValueLengthLimit: 1000,
      eventCountLimit: 100,
      attributePerEventCountLimit: 100,
      linkCountLimit: 10,
      attributePerLinkCountLimit: 100,
    },
  });

  const spanExporter = new OTLPTraceExporter({
    url: "https://otel.baselime.io/v1",
    timeoutMillis: 500,
    headers: {
      "x-api-key": "e9f963244f8b092850d42e34a5339b2d5e68070b".split("").reverse().join(""), // this is a joke
    },
  });

  const spanProcessor = new SimpleSpanProcessor(spanExporter);

  traceProvider.addSpanProcessor(spanProcessor);
  traceProvider.register();

  registerInstrumentations({
    instrumentations: [new FetchInstrumentation()],
  });

  return traceProvider;
}

export const provider = initializeTracing();

export function getTracer() {
  return trace.getTracer("trigger.dev cli", packageJson.version);
}
