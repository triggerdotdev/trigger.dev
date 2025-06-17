import { DiagConsoleLogger, DiagLogLevel, TracerProvider, diag } from "@opentelemetry/api";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import {
  DetectorSync,
  IResource,
  Resource,
  ResourceAttributes,
  ResourceDetectionConfig,
  detectResourcesSync,
  processDetectorSync,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  LogRecordExporter,
  ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { VERSION } from "../../version.js";
import {
  OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT,
  OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT,
  OTEL_LINK_COUNT_LIMIT,
  OTEL_LOG_ATTRIBUTE_COUNT_LIMIT,
  OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT,
  OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT,
  OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT,
  OTEL_SPAN_EVENT_COUNT_LIMIT,
} from "../limits.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import {
  TaskContextLogProcessor,
  TaskContextSpanProcessor,
} from "../taskContext/otelProcessors.js";
import { getEnvVar } from "../utils/getEnv.js";

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

export type TracingDiagnosticLogLevel =
  | "none"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "verbose"
  | "all";

export type TracingSDKConfig = {
  url: string;
  forceFlushTimeoutMillis?: number;
  resource?: IResource;
  instrumentations?: Instrumentation[];
  exporters?: SpanExporter[];
  logExporters?: LogRecordExporter[];
  diagLogLevel?: TracingDiagnosticLogLevel;
};

const idGenerator = new RandomIdGenerator();

export class TracingSDK {
  public readonly asyncResourceDetector = new AsyncResourceDetector();
  private readonly _logProvider: LoggerProvider;
  private readonly _spanExporter: SpanExporter;
  private readonly _traceProvider: NodeTracerProvider;

  public readonly getLogger: LoggerProvider["getLogger"];
  public readonly getTracer: TracerProvider["getTracer"];

  constructor(private readonly config: TracingSDKConfig) {
    setLogLevel(config.diagLogLevel ?? "none");

    const envResourceAttributesSerialized = getEnvVar("OTEL_RESOURCE_ATTRIBUTES");
    const envResourceAttributes = envResourceAttributesSerialized
      ? JSON.parse(envResourceAttributesSerialized)
      : {};

    const commonResources = detectResourcesSync({
      detectors: [processDetectorSync],
    })
      .merge(
        new Resource({
          [SemanticResourceAttributes.CLOUD_PROVIDER]: "trigger.dev",
          [SemanticResourceAttributes.SERVICE_NAME]:
            getEnvVar("OTEL_SERVICE_NAME") ?? "trigger.dev",
          [SemanticInternalAttributes.TRIGGER]: true,
          [SemanticInternalAttributes.CLI_VERSION]: VERSION,
          [SemanticInternalAttributes.SDK_VERSION]: VERSION,
          [SemanticInternalAttributes.SDK_LANGUAGE]: "typescript",
        })
      )
      .merge(config.resource ?? new Resource({}))
      .merge(new Resource(envResourceAttributes));

    const traceProvider = new NodeTracerProvider({
      forceFlushTimeoutMillis: config.forceFlushTimeoutMillis,
      resource: commonResources,
      spanLimits: {
        attributeCountLimit: OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT,
        attributeValueLengthLimit: OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT,
        eventCountLimit: OTEL_SPAN_EVENT_COUNT_LIMIT,
        attributePerEventCountLimit: OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT,
        linkCountLimit: OTEL_LINK_COUNT_LIMIT,
        attributePerLinkCountLimit: OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT,
      },
    });

    const spanExporter = new OTLPTraceExporter({
      url: `${config.url}/v1/traces`,
      timeoutMillis: config.forceFlushTimeoutMillis,
    });

    traceProvider.addSpanProcessor(
      new TaskContextSpanProcessor(
        traceProvider.getTracer("trigger-dev-worker", VERSION),
        getEnvVar("OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchSpanProcessor(spanExporter, {
              maxExportBatchSize: parseInt(getEnvVar("OTEL_SPAN_MAX_EXPORT_BATCH_SIZE") ?? "64"),
              scheduledDelayMillis: parseInt(
                getEnvVar("OTEL_SPAN_SCHEDULED_DELAY_MILLIS") ?? "200"
              ),
              exportTimeoutMillis: parseInt(
                getEnvVar("OTEL_SPAN_EXPORT_TIMEOUT_MILLIS") ?? "30000"
              ),
              maxQueueSize: parseInt(getEnvVar("OTEL_SPAN_MAX_QUEUE_SIZE") ?? "512"),
            })
          : new SimpleSpanProcessor(spanExporter)
      )
    );

    const externalTraceId = idGenerator.generateTraceId();

    for (const exporter of config.exporters ?? []) {
      traceProvider.addSpanProcessor(
        getEnvVar("OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchSpanProcessor(new ExternalSpanExporterWrapper(exporter, externalTraceId), {
              maxExportBatchSize: parseInt(getEnvVar("OTEL_SPAN_MAX_EXPORT_BATCH_SIZE") ?? "64"),
              scheduledDelayMillis: parseInt(
                getEnvVar("OTEL_SPAN_SCHEDULED_DELAY_MILLIS") ?? "200"
              ),
              exportTimeoutMillis: parseInt(
                getEnvVar("OTEL_SPAN_EXPORT_TIMEOUT_MILLIS") ?? "30000"
              ),
              maxQueueSize: parseInt(getEnvVar("OTEL_SPAN_MAX_QUEUE_SIZE") ?? "512"),
            })
          : new SimpleSpanProcessor(new ExternalSpanExporterWrapper(exporter, externalTraceId))
      );
    }

    traceProvider.register();

    registerInstrumentations({
      instrumentations: config.instrumentations ?? [],
      tracerProvider: traceProvider,
    });

    const logExporter = new OTLPLogExporter({
      url: `${config.url}/v1/logs`,
    });

    // To start a logger, you first need to initialize the Logger provider.
    const loggerProvider = new LoggerProvider({
      resource: commonResources,
      logRecordLimits: {
        attributeCountLimit: OTEL_LOG_ATTRIBUTE_COUNT_LIMIT,
        attributeValueLengthLimit: OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT,
      },
    });

    loggerProvider.addLogRecordProcessor(
      new TaskContextLogProcessor(
        getEnvVar("OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchLogRecordProcessor(logExporter, {
              maxExportBatchSize: parseInt(getEnvVar("OTEL_LOG_MAX_EXPORT_BATCH_SIZE") ?? "64"),
              scheduledDelayMillis: parseInt(getEnvVar("OTEL_LOG_SCHEDULED_DELAY_MILLIS") ?? "200"),
              exportTimeoutMillis: parseInt(getEnvVar("OTEL_LOG_EXPORT_TIMEOUT_MILLIS") ?? "30000"),
              maxQueueSize: parseInt(getEnvVar("OTEL_LOG_MAX_QUEUE_SIZE") ?? "512"),
            })
          : new SimpleLogRecordProcessor(logExporter)
      )
    );

    for (const externalLogExporter of config.logExporters ?? []) {
      loggerProvider.addLogRecordProcessor(
        getEnvVar("OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchLogRecordProcessor(
              new ExternalLogRecordExporterWrapper(externalLogExporter, externalTraceId),
              {
                maxExportBatchSize: parseInt(getEnvVar("OTEL_LOG_MAX_EXPORT_BATCH_SIZE") ?? "64"),
                scheduledDelayMillis: parseInt(
                  getEnvVar("OTEL_LOG_SCHEDULED_DELAY_MILLIS") ?? "200"
                ),
                exportTimeoutMillis: parseInt(
                  getEnvVar("OTEL_LOG_EXPORT_TIMEOUT_MILLIS") ?? "30000"
                ),
                maxQueueSize: parseInt(getEnvVar("OTEL_LOG_MAX_QUEUE_SIZE") ?? "512"),
              }
            )
          : new SimpleLogRecordProcessor(
              new ExternalLogRecordExporterWrapper(externalLogExporter, externalTraceId)
            )
      );
    }

    this._logProvider = loggerProvider;
    this._spanExporter = spanExporter;
    this._traceProvider = traceProvider;

    logs.setGlobalLoggerProvider(loggerProvider);

    this.getLogger = loggerProvider.getLogger.bind(loggerProvider);
    this.getTracer = traceProvider.getTracer.bind(traceProvider);
  }

  public async flush() {
    await Promise.all([this._traceProvider.forceFlush(), this._logProvider.forceFlush()]);
  }

  public async shutdown() {
    await Promise.all([this._traceProvider.shutdown(), this._logProvider.shutdown()]);
  }
}

function setLogLevel(level: TracingDiagnosticLogLevel) {
  let diagLogLevel: DiagLogLevel;

  switch (level) {
    case "none":
      diagLogLevel = DiagLogLevel.NONE;
      break;
    case "error":
      diagLogLevel = DiagLogLevel.ERROR;
      break;
    case "warn":
      diagLogLevel = DiagLogLevel.WARN;
      break;
    case "info":
      diagLogLevel = DiagLogLevel.INFO;
      break;
    case "debug":
      diagLogLevel = DiagLogLevel.DEBUG;
      break;
    case "verbose":
      diagLogLevel = DiagLogLevel.VERBOSE;
      break;
    case "all":
      diagLogLevel = DiagLogLevel.ALL;
      break;
    default:
      diagLogLevel = DiagLogLevel.NONE;
  }

  diag.setLogger(new DiagConsoleLogger(), diagLogLevel);
}

class ExternalSpanExporterWrapper {
  constructor(
    private underlyingExporter: SpanExporter,
    private externalTraceId: string
  ) {}

  private transformSpan(span: ReadableSpan): ReadableSpan | undefined {
    if (span.attributes[SemanticInternalAttributes.SPAN_PARTIAL]) {
      // Skip partial spans
      return;
    }

    const spanContext = span.spanContext();

    return {
      ...span,
      spanContext: () => ({ ...spanContext, traceId: this.externalTraceId }),
      parentSpanId: span.attributes[SemanticInternalAttributes.SPAN_ATTEMPT]
        ? undefined
        : span.parentSpanId,
    };
  }

  export(spans: any[], resultCallback: (result: any) => void): void {
    try {
      const modifiedSpans = spans.map(this.transformSpan.bind(this));
      this.underlyingExporter.export(
        modifiedSpans.filter(Boolean) as ReadableSpan[],
        resultCallback
      );
    } catch (e) {
      console.error(e);
    }
  }

  shutdown(): Promise<void> {
    return this.underlyingExporter.shutdown();
  }

  forceFlush?(): Promise<void> {
    return this.underlyingExporter.forceFlush
      ? this.underlyingExporter.forceFlush()
      : Promise.resolve();
  }
}

class ExternalLogRecordExporterWrapper {
  constructor(
    private underlyingExporter: LogRecordExporter,
    private externalTraceId: string
  ) {}

  export(logs: any[], resultCallback: (result: any) => void): void {
    const modifiedLogs = logs.map(this.transformLogRecord.bind(this));

    this.underlyingExporter.export(modifiedLogs, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.underlyingExporter.shutdown();
  }

  transformLogRecord(logRecord: ReadableLogRecord): ReadableLogRecord {
    // If there's no spanContext, or if the externalTraceId is not set, return the original logRecord.
    if (!logRecord.spanContext || !this.externalTraceId) {
      return logRecord;
    }

    // Capture externalTraceId for use within the proxy's scope.
    const { externalTraceId } = this;

    return new Proxy(logRecord, {
      get(target, prop, receiver) {
        if (prop === "spanContext") {
          // Intercept access to spanContext.
          const originalSpanContext = target.spanContext;
          // Ensure originalSpanContext exists (it should, due to the check above, but good for safety).
          if (originalSpanContext) {
            return {
              ...originalSpanContext,
              traceId: externalTraceId, // Override traceId.
            };
          }
          // Fallback if, for some reason, originalSpanContext is undefined here.
          return undefined;
        }
        // For all other properties, defer to the original object.
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
