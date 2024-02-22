import { TracerProvider } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  registerInstrumentations,
  type InstrumentationOption,
} from "@opentelemetry/instrumentation";
import {
  DetectorSync,
  IResource,
  Resource,
  ResourceAttributes,
  ResourceDetectionConfig,
  detectResourcesSync,
} from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { TaskContextLogProcessor, TaskContextSpanProcessor } from "../tasks/taskContextManager";

class AsyncResourceDetector implements DetectorSync {
  private _promise: Promise<ResourceAttributes>;
  private _resolver?: (value: ResourceAttributes) => void;
  private _resolved: boolean = false;

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

    if (this._resolved) {
      return;
    }

    this._resolved = true;
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
  private readonly _spanExporter: SpanExporter;
  private readonly _traceProvider: TracerProvider;

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

    const traceProvider = new NodeTracerProvider({
      forceFlushTimeoutMillis: config.forceFlushTimeoutMillis ?? 500,
      resource: commonResources,
    });

    const spanExporter = new OTLPTraceExporter({
      url: `${config.url}/v1/traces`,
      timeoutMillis: config.forceFlushTimeoutMillis ?? 1000,
    });

    traceProvider.addSpanProcessor(
      new TaskContextSpanProcessor(new SimpleSpanProcessor(spanExporter))
    );
    traceProvider.register();

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

    loggerProvider.addLogRecordProcessor(
      new TaskContextLogProcessor(new SimpleLogRecordProcessor(logExporter))
    );

    this._logProvider = loggerProvider;
    this._spanExporter = spanExporter;
    this._traceProvider = traceProvider;

    logs.setGlobalLoggerProvider(loggerProvider);

    this.getLogger = loggerProvider.getLogger.bind(loggerProvider);
    this.getTracer = traceProvider.getTracer.bind(traceProvider);
  }

  public async flush() {
    await this._spanExporter.forceFlush?.();
    await this._logProvider.forceFlush();
  }

  public async shutdown() {
    await this._spanExporter.shutdown();
    await this._logProvider.shutdown();
  }
}
