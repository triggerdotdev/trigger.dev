import { TracerProvider } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  registerInstrumentations,
  type InstrumentationOption,
} from "@opentelemetry/instrumentation";
import {
  IResource,
  Resource,
  ResourceAttributes,
  detectResourcesSync,
} from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { logs } from "@opentelemetry/api-logs";
import { DetectorSync, ResourceDetectionConfig } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";

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

export type TracingSDKConfig = {
  url: string;
  forceFlushTimeoutMillis?: number;
  resource?: IResource;
  instrumentations?: InstrumentationOption[];
};

export class TracingSDK {
  public readonly asyncResourceDetector = new AsyncResourceDetector();
  private readonly _logProvider: LoggerProvider;
  private readonly _traceExporter: OTLPTraceExporter;

  public readonly getLogger: LoggerProvider["getLogger"];
  public readonly getTracer: TracerProvider["getTracer"];

  constructor(private readonly config: TracingSDKConfig) {
    const commonResources = detectResourcesSync({
      detectors: [this.asyncResourceDetector],
    })
      .merge(
        new Resource({
          [SemanticResourceAttributes.CLOUD_PROVIDER]: "trigger.dev",
          [SemanticInternalAttributes.TRIGGER]: true,
        })
      )
      .merge(config.resource ?? new Resource({}));

    const provider = new NodeTracerProvider({
      forceFlushTimeoutMillis: config.forceFlushTimeoutMillis ?? 500,
      resource: commonResources,
    });

    const exporter = new OTLPTraceExporter({
      url: `${config.url}/v1/traces`,
      timeoutMillis: config.forceFlushTimeoutMillis ?? 1000,
    });

    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();

    registerInstrumentations({
      instrumentations: config.instrumentations ?? [],
    });

    const logExporter = new OTLPLogExporter({
      url: `${config.url}/v1/logs`,
    });

    // To start a logger, you first need to initialize the Logger provider.
    const loggerProvider = new LoggerProvider({
      resource: commonResources,
    });

    loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));

    this._logProvider = loggerProvider;
    this._traceExporter = exporter;

    logs.setGlobalLoggerProvider(loggerProvider);

    this.getLogger = loggerProvider.getLogger.bind(loggerProvider);
    this.getTracer = provider.getTracer.bind(provider);
  }

  public async flushOtel() {
    await this._traceExporter.forceFlush();
    await this._logProvider.forceFlush();
  }
}
