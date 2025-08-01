import {
  DiagConsoleLogger,
  DiagLogLevel,
  SpanContext,
  TracerProvider,
  diag,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { detectResources, processDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LogRecordExporter,
  LogRecordProcessor,
  LoggerProvider,
  ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { RandomIdGenerator, SpanProcessor } from "@opentelemetry/sdk-trace-base";
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
import { taskContext } from "../task-context-api.js";
import { TraceState } from "@opentelemetry/core";

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
  instrumentations?: Instrumentation[];
  exporters?: SpanExporter[];
  logExporters?: LogRecordExporter[];
  diagLogLevel?: TracingDiagnosticLogLevel;
  externalTraceContext?: unknown;
};

const idGenerator = new RandomIdGenerator();

export class TracingSDK {
  private readonly _logProvider: LoggerProvider;
  private readonly _spanExporter: SpanExporter;
  private readonly _traceProvider: NodeTracerProvider;

  public readonly getLogger: LoggerProvider["getLogger"];
  public readonly getTracer: TracerProvider["getTracer"];

  constructor(private readonly config: TracingSDKConfig) {
    setLogLevel(config.diagLogLevel ?? "none");

    const envResourceAttributesSerialized = getEnvVar("TRIGGER_OTEL_RESOURCE_ATTRIBUTES");
    const envResourceAttributes = envResourceAttributesSerialized
      ? JSON.parse(envResourceAttributesSerialized)
      : {};

    const commonResources = detectResources({
      detectors: [processDetector],
    })
      .merge(
        resourceFromAttributes({
          [SemanticResourceAttributes.CLOUD_PROVIDER]: "trigger.dev",
          [SemanticResourceAttributes.SERVICE_NAME]:
            getEnvVar("TRIGGER_OTEL_SERVICE_NAME") ?? "trigger.dev",
          [SemanticInternalAttributes.TRIGGER]: true,
          [SemanticInternalAttributes.CLI_VERSION]: VERSION,
          [SemanticInternalAttributes.SDK_VERSION]: VERSION,
          [SemanticInternalAttributes.SDK_LANGUAGE]: "typescript",
        })
      )
      .merge(resourceFromAttributes(envResourceAttributes))
      .merge(resourceFromAttributes(taskContext.resourceAttributes));

    const spanExporter = new OTLPTraceExporter({
      url: `${config.url}/v1/traces`,
      timeoutMillis: config.forceFlushTimeoutMillis,
    });

    const spanProcessors: Array<SpanProcessor> = [];

    spanProcessors.push(
      new TaskContextSpanProcessor(
        VERSION,
        getEnvVar("TRIGGER_OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchSpanProcessor(spanExporter, {
              maxExportBatchSize: parseInt(
                getEnvVar("TRIGGER_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE") ?? "64"
              ),
              scheduledDelayMillis: parseInt(
                getEnvVar("TRIGGER_OTEL_SPAN_SCHEDULED_DELAY_MILLIS") ?? "200"
              ),
              exportTimeoutMillis: parseInt(
                getEnvVar("TRIGGER_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS") ?? "30000"
              ),
              maxQueueSize: parseInt(getEnvVar("TRIGGER_OTEL_SPAN_MAX_QUEUE_SIZE") ?? "512"),
            })
          : new SimpleSpanProcessor(spanExporter)
      )
    );

    const externalTraceId = idGenerator.generateTraceId();
    const externalTraceContext = extractExternalTraceContext(config.externalTraceContext);

    for (const exporter of config.exporters ?? []) {
      spanProcessors.push(
        getEnvVar("TRIGGER_OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchSpanProcessor(
              new ExternalSpanExporterWrapper(exporter, externalTraceId, externalTraceContext),
              {
                maxExportBatchSize: parseInt(
                  getEnvVar("TRIGGER_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE") ?? "64"
                ),
                scheduledDelayMillis: parseInt(
                  getEnvVar("TRIGGER_OTEL_SPAN_SCHEDULED_DELAY_MILLIS") ?? "200"
                ),
                exportTimeoutMillis: parseInt(
                  getEnvVar("TRIGGER_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS") ?? "30000"
                ),
                maxQueueSize: parseInt(getEnvVar("TRIGGER_OTEL_SPAN_MAX_QUEUE_SIZE") ?? "512"),
              }
            )
          : new SimpleSpanProcessor(
              new ExternalSpanExporterWrapper(exporter, externalTraceId, externalTraceContext)
            )
      );
    }

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
      spanProcessors,
    });

    traceProvider.register();

    registerInstrumentations({
      instrumentations: config.instrumentations ?? [],
      tracerProvider: traceProvider,
    });

    const logExporter = new OTLPLogExporter({
      url: `${config.url}/v1/logs`,
    });

    const logProcessors: Array<LogRecordProcessor> = [
      new TaskContextLogProcessor(
        getEnvVar("OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchLogRecordProcessor(logExporter, {
              maxExportBatchSize: parseInt(getEnvVar("OTEL_LOG_MAX_EXPORT_BATCH_SIZE") ?? "64"),
              scheduledDelayMillis: parseInt(getEnvVar("OTEL_LOG_SCHEDULED_DELAY_MILLIS") ?? "200"),
              exportTimeoutMillis: parseInt(getEnvVar("OTEL_LOG_EXPORT_TIMEOUT_MILLIS") ?? "30000"),
              maxQueueSize: parseInt(getEnvVar("OTEL_LOG_MAX_QUEUE_SIZE") ?? "512"),
            })
          : new SimpleLogRecordProcessor(logExporter)
      ),
    ];

    for (const externalLogExporter of config.logExporters ?? []) {
      logProcessors.push(
        getEnvVar("OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchLogRecordProcessor(
              new ExternalLogRecordExporterWrapper(
                externalLogExporter,
                externalTraceId,
                externalTraceContext
              ),
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
              new ExternalLogRecordExporterWrapper(
                externalLogExporter,
                externalTraceId,
                externalTraceContext
              )
            )
      );
    }

    // To start a logger, you first need to initialize the Logger provider.
    const loggerProvider = new LoggerProvider({
      resource: commonResources,
      logRecordLimits: {
        attributeCountLimit: OTEL_LOG_ATTRIBUTE_COUNT_LIMIT,
        attributeValueLengthLimit: OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT,
      },
      processors: logProcessors,
    });

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
    private externalTraceId: string,
    private externalTraceContext:
      | { traceId: string; spanId: string; tracestate?: string }
      | undefined
  ) {}

  private transformSpan(span: ReadableSpan): ReadableSpan | undefined {
    if (span.attributes[SemanticInternalAttributes.SPAN_PARTIAL]) {
      // Skip partial spans
      return;
    }

    const externalTraceId = this.externalTraceContext
      ? this.externalTraceContext.traceId
      : this.externalTraceId;

    const isAttemptSpan = span.attributes[SemanticInternalAttributes.SPAN_ATTEMPT];

    const spanContext = span.spanContext();
    let parentSpanContext = span.parentSpanContext;

    if (parentSpanContext) {
      parentSpanContext = {
        ...parentSpanContext,
        traceId: externalTraceId,
      };
    }

    if (isAttemptSpan && this.externalTraceContext) {
      parentSpanContext = {
        ...parentSpanContext,
        traceId: externalTraceId,
        spanId: this.externalTraceContext.spanId,
        traceState: this.externalTraceContext.tracestate
          ? new TraceState(this.externalTraceContext.tracestate)
          : undefined,
        traceFlags: parentSpanContext?.traceFlags ?? 0,
      };
    }

    return {
      ...span,
      spanContext: () => ({ ...spanContext, traceId: externalTraceId }),
      parentSpanContext,
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
    private externalTraceId: string,
    private externalTraceContext:
      | { traceId: string; spanId: string; tracestate?: string }
      | undefined
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
    if (!logRecord.spanContext || !this.externalTraceId || !this.externalTraceContext) {
      return logRecord;
    }

    // Capture externalTraceId for use within the proxy's scope.
    const externalTraceId = this.externalTraceContext
      ? this.externalTraceContext.traceId
      : this.externalTraceId;

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

function extractExternalTraceContext(traceContext: unknown) {
  if (typeof traceContext !== "object" || traceContext === null) {
    return undefined;
  }

  const tracestate =
    "tracestate" in traceContext && typeof traceContext.tracestate === "string"
      ? traceContext.tracestate
      : undefined;

  if ("traceparent" in traceContext && typeof traceContext.traceparent === "string") {
    const [version, traceId, spanId] = traceContext.traceparent.split("-");

    if (!traceId || !spanId) {
      return undefined;
    }

    return {
      traceId,
      spanId,
      tracestate: tracestate,
    };
  }

  return undefined;
}
