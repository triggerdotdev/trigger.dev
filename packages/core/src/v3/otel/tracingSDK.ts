import type { TracerProvider } from "@opentelemetry/api";
import { DiagConsoleLogger, DiagLogLevel, TraceFlags, diag, metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { TraceState } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { HostMetrics } from "@opentelemetry/host-metrics";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import type { Resource } from "@opentelemetry/resources";
import { detectResources, processDetector, resourceFromAttributes } from "@opentelemetry/resources";
import type {
  LogRecordExporter,
  LogRecordProcessor,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
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
import { startDiskIoMetrics } from "./diskIoMetrics.js";
import { startFilesystemMetrics } from "./filesystemMetrics.js";
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
  metricExporters?: PushMetricExporter[];
  metricReaders?: MetricReader[];
  diagLogLevel?: TracingDiagnosticLogLevel;
  resource?: Resource;
  hostMetrics?: boolean;
  /** Limit host metrics collection to specific groups (e.g. ["process.cpu", "process.memory"]) */
  hostMetricGroups?: string[];
  /** Enable Node.js runtime metrics (event loop utilization, heap usage, etc.) */
  nodejsRuntimeMetrics?: boolean;
  /** Enable filesystem metrics (Linux only, reads /proc/mounts + fs.statfs) */
  filesystemMetrics?: boolean;
  /** Enable disk I/O metrics (Linux only, reads /proc/diskstats) */
  diskIoMetrics?: boolean;
  /** Metric instrument name patterns to drop (supports wildcards, e.g. "system.cpu.*") */
  droppedMetrics?: string[];
};

const idGenerator = new RandomIdGenerator();

export class TracingSDK {
  private readonly _logProvider: LoggerProvider;
  private readonly _spanExporter: SpanExporter;
  private readonly _traceProvider: NodeTracerProvider;
  private readonly _meterProvider: MeterProvider;
  private readonly _metricReaders: MetricReader[];

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

    // Shared by every wrapper below so a run's spans and logs agree on the id.
    const fallbackTraceIds = new FallbackExternalTraceIds(idGenerator.generateTraceId());

    for (const exporter of config.exporters ?? []) {
      spanProcessors.push(
        getEnvVar("TRIGGER_OTEL_BATCH_PROCESSING_ENABLED") === "1"
          ? new BatchSpanProcessor(new ExternalSpanExporterWrapper(exporter, fallbackTraceIds), {
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
          : new SimpleSpanProcessor(new ExternalSpanExporterWrapper(exporter, fallbackTraceIds))
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
              new ExternalLogRecordExporterWrapper(externalLogExporter, fallbackTraceIds),
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
              new ExternalLogRecordExporterWrapper(externalLogExporter, fallbackTraceIds)
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
      config.metricsUrl ?? getEnvVar("TRIGGER_OTEL_METRICS_ENDPOINT") ?? `${config.url}/v1/metrics`;

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

    const exportTimeoutMillis = parseInt(
      getEnvVar("TRIGGER_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS") ?? "30000"
    );

    const metricReaders: MetricReader[] = [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: collectionIntervalMs,
        exportTimeoutMillis: Math.min(exportTimeoutMillis, collectionIntervalMs),
      }),
      ...(config.metricExporters ?? []).map(
        (exporter) =>
          new PeriodicExportingMetricReader({
            exporter,
            exportIntervalMillis: collectionIntervalMs,
            exportTimeoutMillis: Math.min(exportTimeoutMillis, collectionIntervalMs),
          })
      ),
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
    this._metricReaders = metricReaders;
    metrics.setGlobalMeterProvider(meterProvider);

    if (config.hostMetrics) {
      const hostMetrics = new HostMetrics({
        meterProvider,
        metricGroups: config.hostMetricGroups,
      });
      hostMetrics.start();
    }

    if (config.nodejsRuntimeMetrics) {
      startNodejsRuntimeMetrics(meterProvider);
    }

    if (config.filesystemMetrics) {
      startFilesystemMetrics(meterProvider);
    }

    if (config.diskIoMetrics) {
      startDiskIoMetrics(meterProvider);
    }

    this.getLogger = loggerProvider.getLogger.bind(loggerProvider);
    this.getTracer = traceProvider.getTracer.bind(traceProvider);
  }

  public async flush() {
    await Promise.all([
      this._traceProvider.forceFlush(),
      this._logProvider.forceFlush(),
      this._flushMetricReadersSerially(),
    ]);
  }

  private async _flushMetricReadersSerially() {
    await this._eachMetricReaderSerially("flush", (reader) => reader.forceFlush());
  }

  private async _shutdownMetricReadersSerially() {
    await this._eachMetricReaderSerially("shut down", (reader) => reader.shutdown());
    await this._meterProvider.shutdown();
  }

  private async _eachMetricReaderSerially(
    action: string,
    run: (reader: MetricReader) => Promise<void>
  ) {
    const errors: unknown[] = [];

    for (const reader of this._metricReaders) {
      try {
        await run(reader);
      } catch (error) {
        console.error(`Failed to ${action} metric reader ${reader.constructor.name}`, error);
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  public async shutdown() {
    await Promise.all([
      this._traceProvider.shutdown(),
      this._logProvider.shutdown(),
      this._shutdownMetricReadersSerially(),
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

/** Only the current run and the tail of recently ended ones can still export. */
export const MAX_TRACKED_INTERNAL_TRACES = 64;

/**
 * External trace ids for runs that carry no external trace context — with
 * `processKeepAlive` the `TracingSDK` outlives the run, so an id captured at
 * construction merges every run on the process into one trace.
 *
 * A record's id comes from its own internal trace id rather than from whatever
 * run is current when the exporter is called. Batch processors drain
 * asynchronously, so a run's records are routinely exported after the next run
 * has started, and reading ambient state then would stamp them with the wrong
 * run's id. It also makes a run's spans and logs agree without coordinating.
 *
 * Granularity therefore follows the internal trace, not the run: a run tree
 * shares one internal trace, so a parent and the runs it triggers land on one
 * external trace together, which is the grouping you want.
 */
export class FallbackExternalTraceIds {
  private readonly byInternalTrace = new Map<string, string>();

  constructor(
    private seed: string,
    private traceIdGenerator: Pick<RandomIdGenerator, "generateTraceId"> = idGenerator
  ) {}

  /** False when no external trace id was configured, i.e. external export is off. */
  get enabled(): boolean {
    return !!this.seed;
  }

  forInternalTrace(internalTraceId: string): string {
    // An empty seed means external export is disabled — leave it that way
    // rather than minting an id and switching the feature on.
    if (!this.seed) {
      return this.seed;
    }

    const known = this.byInternalTrace.get(internalTraceId);

    if (known) {
      // Re-insert so the map is ordered by last use rather than first. A run
      // that is still exporting keeps its id even if enough unrelated traces
      // appear alongside it to fill the map, which would otherwise split it
      // across two external traces.
      this.byInternalTrace.delete(internalTraceId);
      this.byInternalTrace.set(internalTraceId, known);

      return known;
    }

    // The first run reuses the id generated at construction, so the configured
    // seed is not thrown away.
    const traceId =
      this.byInternalTrace.size === 0 ? this.seed : this.traceIdGenerator.generateTraceId();

    this.byInternalTrace.set(internalTraceId, traceId);

    if (this.byInternalTrace.size > MAX_TRACKED_INTERNAL_TRACES) {
      // Map iterates in insertion order, so this drops the least recently used.
      const stalest = this.byInternalTrace.keys().next().value;

      if (stalest !== undefined) {
        this.byInternalTrace.delete(stalest);
      }
    }

    return traceId;
  }
}

export class ExternalSpanExporterWrapper {
  constructor(
    private underlyingExporter: SpanExporter,
    private fallback: FallbackExternalTraceIds
  ) {}

  private transformSpan(span: ReadableSpan): ReadableSpan | undefined {
    // Read external context live, so per-run reassignment of
    // standardTraceContextManager.traceContext is honoured on warm-started
    // workers that reuse a single TracingSDK across runs.
    const externalTraceContext = traceContext.getExternalTraceContext();

    const isExternallySampled = externalTraceContext
      ? isTraceFlagSampled(externalTraceContext.traceFlags)
      : this.fallback.enabled;

    if (!isExternallySampled) {
      return;
    }

    if (isSpanInternalOnly(span)) {
      return;
    }

    const externalTraceId = externalTraceContext
      ? externalTraceContext.traceId
      : this.fallback.forInternalTrace(span.spanContext().traceId);

    const isAttemptSpan = span.attributes[SemanticInternalAttributes.SPAN_ATTEMPT];

    const spanContext = span.spanContext();
    let parentSpanContext = span.parentSpanContext;

    if (parentSpanContext) {
      parentSpanContext = {
        ...parentSpanContext,
        traceId: externalTraceId,
      };
    }

    if (isAttemptSpan && externalTraceContext) {
      parentSpanContext = {
        ...parentSpanContext,
        traceId: externalTraceId,
        spanId: externalTraceContext.spanId,
        traceState: externalTraceContext.tracestate
          ? new TraceState(externalTraceContext.tracestate)
          : undefined,
        traceFlags: externalTraceContext.traceFlags,
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

export class ExternalLogRecordExporterWrapper {
  constructor(
    private underlyingExporter: LogRecordExporter,
    private fallback: FallbackExternalTraceIds
  ) {}

  export(logs: any[], resultCallback: (result: any) => void): void {
    const externalTraceContext = traceContext.getExternalTraceContext();

    const isExternallySampled = externalTraceContext
      ? isTraceFlagSampled(externalTraceContext.traceFlags)
      : this.fallback.enabled;

    if (!isExternallySampled) {
      this.underlyingExporter.export([], resultCallback);

      return;
    }

    const modifiedLogs = logs.map((log) => this.transformLogRecord(log, externalTraceContext));

    this.underlyingExporter.export(modifiedLogs, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.underlyingExporter.shutdown();
  }

  forceFlush(): Promise<void> {
    const underlyingExporter = this.underlyingExporter as LogRecordExporter & {
      forceFlush?: () => Promise<void>;
    };

    return underlyingExporter.forceFlush ? underlyingExporter.forceFlush() : Promise.resolve();
  }

  transformLogRecord(
    logRecord: ReadableLogRecord,
    externalTraceContext:
      | { traceId: string; spanId: string; tracestate?: string; traceFlags: number }
      | undefined
  ): ReadableLogRecord {
    // Without a spanContext there is no internal trace id to key the fallback
    // on, and nothing to rewrite.
    if (!logRecord.spanContext) {
      return logRecord;
    }

    // Capture externalTraceId for use within the proxy's scope. Use
    // externalTraceContext.traceId if available, otherwise the id belonging to
    // the run this record came from.
    const externalTraceId = externalTraceContext
      ? externalTraceContext.traceId
      : this.fallback.forInternalTrace(logRecord.spanContext.traceId);

    if (!externalTraceId) {
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
  } catch (_e) {
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

function parseOtelResourceAttributes(
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
