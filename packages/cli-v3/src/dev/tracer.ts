import { TracerProvider } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { Resource, ResourceAttributes, detectResourcesSync } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { logs } from "@opentelemetry/api-logs";
import { DetectorSync, ResourceDetectionConfig } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";

class AsyncResourceDetector implements DetectorSync {
  private _promise: Promise<ResourceAttributes>;
  private _resolver?: (value: ResourceAttributes) => void;

  constructor() {
    this._promise = new Promise((resolver) => {
      this._resolver = resolver;
    });
  }

  detect(_config?: ResourceDetectionConfig): Resource {
    return new Resource({}, this._promise);
  }

  resolveWithAttributes(attributes: ResourceAttributes) {
    if (!this._resolver) {
      throw new Error("Resolver not available");
    }

    this._resolver(attributes);
  }
}

export const asyncResourceDetector = new AsyncResourceDetector();

const commonResources = detectResourcesSync({
  detectors: [asyncResourceDetector],
}).merge(
  new Resource({
    [SemanticResourceAttributes.CLOUD_PROVIDER]: "trigger.dev",
    [SemanticInternalAttributes.TRIGGER]: true,
  })
);

const provider = new NodeTracerProvider({
  forceFlushTimeoutMillis: 500,
  resource: commonResources,
});

const exporter = new OTLPTraceExporter({
  url: "http://0.0.0.0:4318/v1/traces",
  timeoutMillis: 1000,
});

provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

registerInstrumentations({
  instrumentations: [new FetchInstrumentation()],
});

const logExporter = new OTLPLogExporter({
  url: "http://0.0.0.0:4318/v1/logs",
});

// To start a logger, you first need to initialize the Logger provider.
const loggerProvider = new LoggerProvider({
  resource: commonResources,
});

loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));

logs.setGlobalLoggerProvider(loggerProvider);

//  To create a log record, you first need to get a Logger instance
export const getLogger: LoggerProvider["getLogger"] = loggerProvider.getLogger.bind(loggerProvider);
export const getTracer: TracerProvider["getTracer"] = provider.getTracer.bind(provider);

export async function flushOtel() {
  await exporter.forceFlush();
  await loggerProvider.forceFlush();
}
