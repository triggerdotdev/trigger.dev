import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { Resource, detectResourcesSync, processDetectorSync } from "@opentelemetry/resources";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { logger } from "../utilities/logger.js";
import { VERSION } from "../consts.js";

function initializeTracing(): NodeTracerProvider | undefined {
  if (
    process.argv.includes("--skip-telemetry") ||
    process.env.TRIGGER_DEV_SKIP_TELEMETRY || // only for backwards compat
    process.env.TRIGGER_TELEMETRY_DISABLED
  ) {
    logger.debug("📉 Telemetry disabled");
    return;
  }

  if (process.env.OTEL_INTERNAL_DIAG_DEBUG) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = detectResourcesSync({
    detectors: [processDetectorSync],
  }).merge(
    new Resource({
      [SEMRESATTRS_SERVICE_NAME]: "trigger.dev cli v3",
      [SEMRESATTRS_SERVICE_VERSION]: VERSION,
    })
  );

  const traceProvider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 30_000,
    resource,
    spanLimits: {
      attributeCountLimit: 1000,
      attributeValueLengthLimit: 2048,
      eventCountLimit: 100,
      attributePerEventCountLimit: 100,
      linkCountLimit: 10,
      attributePerLinkCountLimit: 100,
    },
  });

  const spanExporter = new OTLPTraceExporter({
    url: "https://otel.baselime.io/v1",
    timeoutMillis: 5000,
    headers: {
      "x-api-key": "b6e0fbbaf8dc2524773d2152ae2e9eb5c7fbaa52",
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
  return trace.getTracer("trigger.dev cli v3", VERSION);
}
