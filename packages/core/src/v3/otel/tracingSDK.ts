import { DiagConsoleLogger, DiagLogLevel, TracerProvider, diag } from "@opentelemetry/api";
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
  processDetectorSync,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT,
  OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT,
  OTEL_LINK_COUNT_LIMIT,
  OTEL_LOG_ATTRIBUTE_COUNT_LIMIT,
  OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT,
  OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT,
  OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT,
  OTEL_SPAN_EVENT_COUNT_LIMIT,
} from "../limits";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { TaskContextLogProcessor, TaskContextSpanProcessor } from "../taskContext/otelProcessors";
import { getEnvVar } from "../utils/getEnv";
import { version } from "../../../package.json";

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
  instrumentations?: InstrumentationOption[];
  diagLogLevel?: TracingDiagnosticLogLevel;
};

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
      detectors: [this.asyncResourceDetector, processDetectorSync],
    })
      .merge(
        new Resource({
          [SemanticResourceAttributes.CLOUD_PROVIDER]: "trigger.dev",
          [SemanticInternalAttributes.TRIGGER]: true,
          [SemanticInternalAttributes.CLI_VERSION]: version,
        })
      )
      .merge(config.resource ?? new Resource({}))
      .merge(new Resource(envResourceAttributes));

    const traceProvider = new NodeTracerProvider({
      forceFlushTimeoutMillis: config.forceFlushTimeoutMillis ?? 500,
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
      timeoutMillis: config.forceFlushTimeoutMillis ?? 1000,
    });

    traceProvider.addSpanProcessor(
      new TaskContextSpanProcessor(
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

    this._logProvider = loggerProvider;
    this._spanExporter = spanExporter;
    this._traceProvider = traceProvider;

    logs.setGlobalLoggerProvider(loggerProvider);

    this.getLogger = loggerProvider.getLogger.bind(loggerProvider);
    this.getTracer = traceProvider.getTracer.bind(traceProvider);
  }

  public async flush() {
    await this._traceProvider.forceFlush();
    await this._logProvider.forceFlush();
  }

  public async shutdown() {
    await this._traceProvider.shutdown();
    await this._logProvider.shutdown();
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
