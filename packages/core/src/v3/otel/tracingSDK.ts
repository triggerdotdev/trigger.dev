import {
  DiagConsoleLogger,
  DiagLogLevel,
  TraceFlags,
  TracerProvider,
  diag,
  metrics,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { TraceState } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { HostMetrics } from "@opentelemetry/host-metrics";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import {
  detectResources,
  processDetector,
  Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LogRecordExporter,
  LogRecordProcessor,
  LoggerProvider,
  ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { RandomIdGenerator, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanExporter,
} from "@opentelemetry/sdk-trace-node";
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
import { taskContext } from "../task-context-api.js";
import {
  BufferingMetricExporter,
  TaskContextLogProcessor,
  TaskContextMetricExporter,
  TaskContextSpanProcessor,
} from "../taskContext/otelProcessors.js";
import { traceContext } from "../trace-context-api.js";
import { getEnvVar } from "../utils/getEnv.js";
import { machineId } from "./machineId.js";
import { startNodejsRuntimeMetrics } from "./nodejsRuntimeMetrics.js";

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
  metricsUrl?: string;
  forceFlushTimeoutMillis?: number;
  instrumentations?: Instrumentation[];
  exporters?: SpanExporter[];
  logExporters?: LogRecordExporter[];
  metricReaders?: MetricReader[];
  diagLogLevel?: TracingDiagnosticLogLevel;
  resource?: Resource;
  hostMetrics?: boolean;
  /** Enable Node.js runtime metrics (event loop utilization, heap usage, etc.) */
  nodejsRuntimeMetrics?: boolean;
  /** Metric instrument name patterns to drop (supports wildcards, e.g. "system.cpu.*") */
  droppedMetrics?: string[];
};

const idGenerator = new RandomIdGenerator();

export class TracingSDK {
  private readonly _logProvider: LoggerProvider;
  private readonly _spanExporter: SpanExporter;
  private readonly _traceProvider: NodeTracerProvider;
  private readonly _meterProvider: MeterProvider;

  public readonly getLogger: LoggerProvider["getLogger"];
  public readonly getTracer: TracerProvider["getTracer"];

  constructor(private readonly config: TracingSDKConfig) {
    setLogLevel(config.diagLogLevel ?? "none");

    const envResourceAttributesSerialized = getEnvVar("TRIGGER_OTEL_RESOURCE_ATTRIBUTES");
    const envResourceAttributes = envResourceAttributesSerialized
      ? JSON.parse(envResourceAttributesSerialized)
      : {};

    const customEnvResourceAttributes = parseOtelResourceAttributes(
      getEnvVar("CUSTOM_OTEL_RESOURCE_ATTRIBUTES")
    );

    const commonResources = detectResources({
      detectors: [processDetector],
    })
      .merge(
        resourceFromAttributes({
          "cloud.provider": "trigger.dev",
          "service.name": getEnvVar("TRIGGER_OTEL_SERVICE_NAME") ?? "trigger.dev",
          [SemanticInternalAttributes.TRIGGER]: true,
          [SemanticInternalAttributes.CLI_VERSION]: VERSION,
          [SemanticInternalAttributes.SDK_VERSION]: VERSION,
          [SemanticInternalAttributes.SDK_LANGUAGE]: "typescript",
          [SemanticInternalAttributes.MACHINE_ID]: machineId,
        })
      )
      .merge(resourceFromAttributes(envResourceAttributes))
      .merge(resourceFromAttributes(customEnvResourceAttributes))
      .merge(resourceFromAttributes(taskContext.resourceAttributes))
      .merge(config.resource ?? resourceFromAttributes({}));

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
    const externalTraceContext = traceContext.getExternalTraceContext();

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
        getEnvVar("TRIGGER_OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchLogRecordProcessor(logExporter, {
              maxExportBatchSize: parseInt(
                getEnvVar("TRIGGER_OTEL_LOG_MAX_EXPORT_BATCH_SIZE") ?? "64"
              ),
              scheduledDelayMillis: parseInt(
                getEnvVar("TRIGGER_OTEL_LOG_SCHEDULED_DELAY_MILLIS") ?? "200"
              ),
              exportTimeoutMillis: parseInt(
                getEnvVar("TRIGGER_OTEL_LOG_EXPORT_TIMEOUT_MILLIS") ?? "30000"
              ),
              maxQueueSize: parseInt(getEnvVar("TRIGGER_OTEL_LOG_MAX_QUEUE_SIZE") ?? "512"),
            })
          : new SimpleLogRecordProcessor(logExporter)
      ),
    ];

    for (const externalLogExporter of config.logExporters ?? []) {
      logProcessors.push(
        getEnvVar("TRIGGER_OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchLogRecordProcessor(
              new ExternalLogRecordExporterWrapper(
                externalLogExporter,
                externalTraceId,
                externalTraceContext
              ),
              {
                maxExportBatchSize: parseInt(
                  getEnvVar("TRIGGER_OTEL_LOG_MAX_EXPORT_BATCH_SIZE") ?? "64"
                ),
                scheduledDelayMillis: parseInt(
                  getEnvVar("TRIGGER_OTEL_LOG_SCHEDULED_DELAY_MILLIS") ?? "200"
                ),
                exportTimeoutMillis: parseInt(
                  getEnvVar("TRIGGER_OTEL_LOG_EXPORT_TIMEOUT_MILLIS") ?? "30000"
                ),
                maxQueueSize: parseInt(getEnvVar("TRIGGER_OTEL_LOG_MAX_QUEUE_SIZE") ?? "512"),
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

    // Metrics setup
    const metricsUrl =
      config.metricsUrl ??
      getEnvVar("TRIGGER_OTEL_METRICS_ENDPOINT") ??
      `${config.url}/v1/metrics`;

    const rawMetricExporter = new OTLPMetricExporter({
      url: metricsUrl,
      timeoutMillis: config.forceFlushTimeoutMillis,
    });

    const collectionIntervalMs = parseInt(
      getEnvVar("TRIGGER_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS") ?? "10000"
    );
    const exportIntervalMs = parseInt(
      getEnvVar("TRIGGER_OTEL_METRICS_EXPORT_INTERVAL_MILLIS") ?? "30000"
    );

    // Chain: PeriodicReader(10s) → TaskContextMetricExporter → BufferingMetricExporter(30s) → OTLP
    const bufferingExporter = new BufferingMetricExporter(rawMetricExporter, exportIntervalMs);
    const metricExporter = new TaskContextMetricExporter(bufferingExporter);

    const metricReaders: MetricReader[] = [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: collectionIntervalMs,
        exportTimeoutMillis: parseInt(
          getEnvVar("TRIGGER_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS") ?? "30000"
        ),
      }),
      ...(config.metricReaders ?? []),
    ];

    const meterProvider = new MeterProvider({
      resource: commonResources,
      readers: metricReaders,
      views: (config.droppedMetrics ?? []).map((pattern) => ({
        instrumentName: pattern,
        aggregation: { type: AggregationType.DROP },
      })),
    });

    this._meterProvider = meterProvider;
    metrics.setGlobalMeterProvider(meterProvider);

    if (config.hostMetrics) {
      const hostMetrics = new HostMetrics({ meterProvider });
      hostMetrics.start();
    }

    if (config.nodejsRuntimeMetrics) {
      startNodejsRuntimeMetrics(meterProvider);
    }

    this.getLogger = loggerProvider.getLogger.bind(loggerProvider);
    this.getTracer = traceProvider.getTracer.bind(traceProvider);
  }

  public async flush() {
    await Promise.all([
      this._traceProvider.forceFlush(),
      this._logProvider.forceFlush(),
      this._meterProvider.forceFlush(),
    ]);
  }

  public async shutdown() {
    await Promise.all([
      this._traceProvider.shutdown(),
      this._logProvider.shutdown(),
      this._meterProvider.shutdown(),
    ]);
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
  private readonly _isExternallySampled: boolean;

  constructor(
    private underlyingExporter: SpanExporter,
    private externalTraceId: string,
    private externalTraceContext:
      | { traceId: string; spanId: string; traceFlags: number; tracestate?: string }
      | undefined
  ) {
    this._isExternallySampled = externalTraceContext
      ? isTraceFlagSampled(externalTraceContext.traceFlags)
      : !!externalTraceId;
  }

  private transformSpan(span: ReadableSpan): ReadableSpan | undefined {
    if (!this._isExternallySampled) {
      return;
    }

    if (isSpanInternalOnly(span)) {
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
        traceFlags: this.externalTraceContext.traceFlags,
      };
    } else if (isAttemptSpan) {
      parentSpanContext = undefined;
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
  private readonly _isExternallySampled: boolean;

  constructor(
    private underlyingExporter: LogRecordExporter,
    private externalTraceId: string,
    private externalTraceContext:
      | { traceId: string; spanId: string; tracestate?: string; traceFlags: number }
      | undefined
  ) {
    this._isExternallySampled = externalTraceContext
      ? isTraceFlagSampled(externalTraceContext.traceFlags)
      : !!externalTraceId;
  }

  export(logs: any[], resultCallback: (result: any) => void): void {
    if (!this._isExternallySampled) {
      this.underlyingExporter.export([], resultCallback);

      return;
    }

    const modifiedLogs = logs.map(this.transformLogRecord.bind(this));

    this.underlyingExporter.export(modifiedLogs, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.underlyingExporter.shutdown();
  }

  transformLogRecord(logRecord: ReadableLogRecord): ReadableLogRecord {
    // Capture externalTraceId for use within the proxy's scope.
    // Use externalTraceContext.traceId if available, otherwise fall back to generated externalTraceId
    const externalTraceId = this.externalTraceContext
      ? this.externalTraceContext.traceId
      : this.externalTraceId;

    // If there's no spanContext, or if the externalTraceId is not set, return the original logRecord.
    if (!logRecord.spanContext || !externalTraceId) {
      return logRecord;
    }

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

function isSpanInternalOnly(span: ReadableSpan): boolean {
  if (span.attributes[SemanticInternalAttributes.SPAN_PARTIAL]) {
    // Skip partial spans
    return true;
  }

  const urlPath = span.attributes["url.path"];

  if (typeof urlPath === "string" && urlPath === "/api/v1/usage/ingest") {
    return true;
  }

  const httpUrl = span.attributes["http.url"] ?? span.attributes["url.full"];

  const url = safeParseUrl(httpUrl);

  if (!url) {
    return false;
  }

  const internalHosts = [
    "api.trigger.dev",
    "billing.trigger.dev",
    "cloud.trigger.dev",
    "engine.trigger.dev",
    "platform.trigger.dev",
  ];

  return (
    internalHosts.some((host) => url.hostname.includes(host)) ||
    url.pathname.includes("/api/v1/usage/ingest")
  );
}

function safeParseUrl(url: unknown): URL | undefined {
  if (typeof url !== "string") {
    return undefined;
  }

  try {
    return new URL(url);
  } catch (e) {
    return undefined;
  }
}

function isTraceFlagSampled(traceFlags?: number): boolean {
  if (typeof traceFlags !== "number") {
    return true;
  }

  return (traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
}

function isPrintableAscii(str: string): boolean {
  // printable ASCII: 0x20 (space) .. 0x7E (~)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isValid(name: string | undefined): boolean {
  if (!name) return false;
  return typeof name === "string" && name.length <= 255 && isPrintableAscii(name);
}

function isValidAndNotEmpty(name: string | undefined): boolean {
  if (!name) return false;
  return isValid(name) && name.length > 0;
}

export function parseOtelResourceAttributes(
  rawEnvAttributes: string | undefined | null
): Record<string, string> {
  if (!rawEnvAttributes) return {};

  const COMMA = ",";
  const KV = "=";
  const attributes: Record<string, string> = {};

  // use negative limit to support trailing empty attribute
  const rawAttributes = rawEnvAttributes.split(COMMA, -1);
  for (const rawAttribute of rawAttributes) {
    const keyValuePair = rawAttribute.split(KV, -1);
    if (keyValuePair.length !== 2) {
      // skip invalid pair
      continue;
    }
    let [key, value] = keyValuePair;
    key = key?.trim();
    // trim and remove surrounding double quotes
    value = value?.trim().replace(/^"|"$/g, "");

    if (!value || !key) {
      continue;
    }

    if (!isValidAndNotEmpty(key)) {
      throw new Error(
        `Attribute key should be a ASCII string with a length greater than 0 and not exceed 255 characters.`
      );
    }
    if (!isValid(value)) {
      throw new Error(
        `Attribute value should be a ASCII string with a length not exceed 255 characters.`
      );
    }

    // decode percent-encoding (deployment%20name -> deployment name)
    try {
      attributes[key] = decodeURIComponent(value);
    } catch (e: unknown) {
      // decodeURIComponent can throw for malformed sequences; rethrow or handle
      if (e instanceof Error) {
        throw new Error(`Failed to decode attribute value for key ${key}: ${e.message}`);
      }
      throw new Error(`Failed to decode attribute value for key ${key}`);
    }
  }

  return attributes;
}
