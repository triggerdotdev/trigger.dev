import {
  type Attributes,
  type Context,
  DiagConsoleLogger,
  DiagLogLevel,
  type Link,
  type Span,
  type SpanKind,
  type SpanOptions,
  SpanStatusCode,
  diag,
  trace,
  metrics,
  type Meter,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  SimpleSpanProcessor,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { HostMetrics } from "@opentelemetry/host-metrics";
import { AwsInstrumentation as AwsSdkInstrumentation } from "@opentelemetry/instrumentation-aws-sdk";
import { awsEcsDetector, awsEc2Detector } from "@opentelemetry/resource-detector-aws";
import {
  detectResources,
  resourceFromAttributes,
  serviceInstanceIdDetector,
  osDetector,
  hostDetector,
  processDetector,
  type ResourceDetector,
} from "@opentelemetry/resources";
import { env } from "~/env.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";
import { LoggerSpanExporter } from "./telemetry/loggerExporter.server";
import { CompactMetricExporter } from "./telemetry/compactMetricExporter.server";
import { logger } from "~/services/logger.server";
import { flattenAttributes } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { metricsRegister } from "~/metrics.server";
import type { Prisma } from "@trigger.dev/database";
import { performance } from "node:perf_hooks";

export const SEMINTATTRS_FORCE_RECORDING = "forceRecording";

class CustomWebappSampler implements Sampler {
  constructor(private readonly _baseSampler: Sampler) {}

  // Drop spans where a prisma library is the root span
  shouldSample(
    context: Context,
    traceId: string,
    name: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const parentContext = trace.getSpanContext(context);

    // Exclude Prisma spans (adjust this logic as needed for your use case)
    if (!parentContext && name.includes("prisma")) {
      return { decision: SamplingDecision.NOT_RECORD };
    }

    // If the span has the forceRecording attribute, always record it
    if (attributes[SEMINTATTRS_FORCE_RECORDING]) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }

    // For all other spans, defer to the base sampler
    const result = this._baseSampler.shouldSample(
      context,
      traceId,
      name,
      spanKind,
      attributes,
      links
    );

    return result;
  }

  toString(): string {
    return `CustomWebappSampler`;
  }
}

export const {
  tracer,
  logger: otelLogger,
  provider,
  meter,
} = singleton("opentelemetry", setupTelemetry);

export async function startActiveSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else if (typeof error === "string") {
        span.recordException(new Error(error));
      } else {
        span.recordException(new Error(String(error)));
      }

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });

      logger.debug(`Error in span: ${name}`, { error });

      throw error;
    } finally {
      span.end();
    }
  });
}

export async function emitDebugLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.DEBUG,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitInfoLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.INFO,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitErrorLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.ERROR,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

export async function emitWarnLog(message: string, params: Record<string, unknown> = {}) {
  otelLogger.emit({
    severityNumber: SeverityNumber.WARN,
    body: message,
    attributes: { ...flattenAttributes(params, "params") },
  });
}

function getResource() {
  const detectors: ResourceDetector[] = [serviceInstanceIdDetector];

  if (env.INTERNAL_OTEL_ADDITIONAL_DETECTORS_ENABLED) {
    detectors.push(osDetector, hostDetector, processDetector, awsEcsDetector, awsEc2Detector);
  }

  const detectedResource = detectResources({ detectors });

  const baseResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: env.SERVICE_NAME,
  });

  return baseResource.merge(detectedResource);
}

function setupTelemetry() {
  if (env.INTERNAL_OTEL_TRACE_DISABLED === "1") {
    console.log(`🔦 Tracer disabled, returning a noop tracer`);

    return {
      tracer: trace.getTracer("trigger.dev", "3.3.12"),
      logger: logs.getLogger("trigger.dev", "3.3.12"),
      provider: new NodeTracerProvider(),
      meter: setupMetrics(),
    };
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const samplingRate = 1.0 / Math.max(parseInt(env.INTERNAL_OTEL_TRACE_SAMPLING_RATE, 10), 1);

  const spanProcessors: SpanProcessor[] = [];

  if (env.INTERNAL_OTEL_TRACE_EXPORTER_URL) {
    const headers = parseInternalTraceHeaders() ?? {};

    const exporter = new OTLPTraceExporter({
      url: env.INTERNAL_OTEL_TRACE_EXPORTER_URL,
      timeoutMillis: 15_000,
      headers,
    });

    spanProcessors.push(
      new BatchSpanProcessor(exporter, {
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: 30000,
        maxQueueSize: 2048,
      })
    );

    console.log(
      `🔦 Tracer: OTLP exporter enabled to ${env.INTERNAL_OTEL_TRACE_EXPORTER_URL} (sampling = ${samplingRate})`
    );
  } else {
    if (env.INTERNAL_OTEL_TRACE_LOGGING_ENABLED === "1") {
      console.log(`🔦 Tracer: Logger exporter enabled (sampling = ${samplingRate})`);

      const loggerExporter = new LoggerSpanExporter();
      spanProcessors.push(new SimpleSpanProcessor(loggerExporter));
    }
  }

  const provider = new NodeTracerProvider({
    forceFlushTimeoutMillis: 15_000,
    resource: getResource(),
    sampler: new ParentBasedSampler({
      root: new CustomWebappSampler(new TraceIdRatioBasedSampler(samplingRate)),
    }),
    spanLimits: {
      attributeCountLimit: 1024,
    },
    spanProcessors,
  });

  if (env.INTERNAL_OTEL_LOG_EXPORTER_URL) {
    const headers = parseInternalTraceHeaders() ?? {};

    const logExporter = new OTLPLogExporter({
      url: env.INTERNAL_OTEL_LOG_EXPORTER_URL,
      timeoutMillis: 15_000,
      headers,
    });

    const batchLogExporter = new BatchLogRecordProcessor(logExporter, {
      maxExportBatchSize: 64,
      scheduledDelayMillis: 200,
      exportTimeoutMillis: 30000,
      maxQueueSize: 512,
    });

    const loggerProvider = new LoggerProvider({
      resource: getResource(),
      logRecordLimits: {
        attributeCountLimit: 1000,
      },
      processors: [batchLogExporter],
    });

    logs.setGlobalLoggerProvider(loggerProvider);

    console.log(
      `🔦 Tracer: OTLP log exporter enabled to ${env.INTERNAL_OTEL_LOG_EXPORTER_URL} (sampling = ${samplingRate})`
    );
  }

  provider.register();

  let instrumentations: Instrumentation[] = [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new AwsSdkInstrumentation({
      suppressInternalInstrumentation: true,
    }),
  ];

  if (env.INTERNAL_OTEL_TRACE_INSTRUMENT_PRISMA_ENABLED === "1") {
    instrumentations.push(new PrismaInstrumentation());
  }

  registerInstrumentations({
    tracerProvider: provider,
    loggerProvider: logs.getLoggerProvider(),
    instrumentations,
  });

  return {
    tracer: provider.getTracer("trigger.dev", "3.3.12"),
    logger: logs.getLogger("trigger.dev", "3.3.12"),
    meter: setupMetrics(),
    provider,
  };
}

function setupMetrics() {
  if (env.INTERNAL_OTEL_METRIC_EXPORTER_ENABLED === "0") {
    return metrics.getMeter("trigger.dev", "3.3.12");
  }

  const exporter = createMetricsExporter();

  const meterProvider = new MeterProvider({
    resource: getResource(),
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: env.INTERNAL_OTEL_METRIC_EXPORTER_INTERVAL_MS,
        exportTimeoutMillis: env.INTERNAL_OTEL_METRIC_EXPORTER_INTERVAL_MS,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);

  const meter = meterProvider.getMeter("trigger.dev", "3.3.12");

  configurePrismaMetrics({ meter });
  configureNodejsMetrics({ meter });
  configureHostMetrics({ meterProvider });

  return meter;
}

function configurePrismaMetrics({ meter }: { meter: Meter }) {
  // Counters
  const queriesTotal = meter.createObservableCounter("db.client.queries.total", {
    description: "Total number of Prisma Client queries executed",
    unit: "queries",
  });
  const datasourceQueriesTotal = meter.createObservableCounter("db.datasource.queries.total", {
    description: "Total number of datasource queries executed",
    unit: "queries",
  });
  const connectionsOpenedTotal = meter.createObservableCounter("db.pool.connections.opened.total", {
    description: "Total number of pool connections opened",
    unit: "connections",
  });
  const connectionsClosedTotal = meter.createObservableCounter("db.pool.connections.closed.total", {
    description: "Total number of pool connections closed",
    unit: "connections",
  });

  // Gauges
  const queriesActive = meter.createObservableGauge("db.client.queries.active", {
    description: "Number of currently active Prisma Client queries",
    unit: "queries",
  });
  const queriesWait = meter.createObservableGauge("db.client.queries.wait", {
    description: "Number of queries currently waiting for a connection",
    unit: "queries",
  });
  const totalGauge = meter.createObservableGauge("db.pool.connections.total", {
    description: "Open Prisma-pool connections",
    unit: "connections",
  });
  const busyGauge = meter.createObservableGauge("db.pool.connections.busy", {
    description: "Connections currently executing queries",
    unit: "connections",
  });
  const freeGauge = meter.createObservableGauge("db.pool.connections.free", {
    description: "Idle (free) connections in the pool",
    unit: "connections",
  });

  // Histogram statistics as gauges
  const queriesWaitTimeCount = meter.createObservableGauge("db.client.queries.wait_time.count", {
    description: "Number of wait time observations",
    unit: "observations",
  });
  const queriesWaitTimeSum = meter.createObservableGauge("db.client.queries.wait_time.sum", {
    description: "Total wait time across all observations",
    unit: "ms",
  });
  const queriesWaitTimeMean = meter.createObservableGauge("db.client.queries.wait_time.mean", {
    description: "Average wait time for a connection",
    unit: "ms",
  });

  const queriesDurationCount = meter.createObservableGauge("db.client.queries.duration.count", {
    description: "Number of query duration observations",
    unit: "observations",
  });
  const queriesDurationSum = meter.createObservableGauge("db.client.queries.duration.sum", {
    description: "Total query duration across all observations",
    unit: "ms",
  });
  const queriesDurationMean = meter.createObservableGauge("db.client.queries.duration.mean", {
    description: "Average duration of Prisma Client queries",
    unit: "ms",
  });

  const datasourceQueriesDurationCount = meter.createObservableGauge(
    "db.datasource.queries.duration.count",
    {
      description: "Number of datasource query duration observations",
      unit: "observations",
    }
  );
  const datasourceQueriesDurationSum = meter.createObservableGauge(
    "db.datasource.queries.duration.sum",
    {
      description: "Total datasource query duration across all observations",
      unit: "ms",
    }
  );
  const datasourceQueriesDurationMean = meter.createObservableGauge(
    "db.datasource.queries.duration.mean",
    {
      description: "Average duration of datasource queries",
      unit: "ms",
    }
  );

  // Single helper so we hit Prisma only once per scrape ---------------------
  async function readPrismaMetrics() {
    const metrics = await prisma.$metrics.json();

    // Extract counter values
    const counters: Record<string, number> = {};
    for (const counter of metrics.counters) {
      counters[counter.key] = counter.value;
    }

    // Extract gauge values
    const gauges: Record<string, number> = {};
    for (const gauge of metrics.gauges) {
      gauges[gauge.key] = gauge.value;
    }

    // Extract histogram values
    const histograms: Record<string, Prisma.MetricHistogram> = {};
    for (const histogram of metrics.histograms) {
      histograms[histogram.key] = histogram.value;
    }

    return {
      counters: {
        queriesTotal: counters["prisma_client_queries_total"] ?? 0,
        datasourceQueriesTotal: counters["prisma_datasource_queries_total"] ?? 0,
        connectionsOpenedTotal: counters["prisma_pool_connections_opened_total"] ?? 0,
        connectionsClosedTotal: counters["prisma_pool_connections_closed_total"] ?? 0,
      },
      gauges: {
        queriesActive: gauges["prisma_client_queries_active"] ?? 0,
        queriesWait: gauges["prisma_client_queries_wait"] ?? 0,
        connectionsOpen: gauges["prisma_pool_connections_open"] ?? 0,
        connectionsBusy: gauges["prisma_pool_connections_busy"] ?? 0,
        connectionsIdle: gauges["prisma_pool_connections_idle"] ?? 0,
      },
      histograms: {
        queriesWait: histograms["prisma_client_queries_wait_histogram_ms"],
        queriesDuration: histograms["prisma_client_queries_duration_histogram_ms"],
        datasourceQueriesDuration: histograms["prisma_datasource_queries_duration_histogram_ms"],
      },
    };
  }

  meter.addBatchObservableCallback(
    async (res) => {
      const { counters, gauges, histograms } = await readPrismaMetrics();

      // Observe counters
      res.observe(queriesTotal, counters.queriesTotal);
      res.observe(datasourceQueriesTotal, counters.datasourceQueriesTotal);
      res.observe(connectionsOpenedTotal, counters.connectionsOpenedTotal);
      res.observe(connectionsClosedTotal, counters.connectionsClosedTotal);

      // Observe gauges
      res.observe(queriesActive, gauges.queriesActive);
      res.observe(queriesWait, gauges.queriesWait);
      res.observe(totalGauge, gauges.connectionsOpen);
      res.observe(busyGauge, gauges.connectionsBusy);
      res.observe(freeGauge, gauges.connectionsIdle);

      // Observe histogram statistics as gauges
      if (histograms.queriesWait) {
        res.observe(queriesWaitTimeCount, histograms.queriesWait.count);
        res.observe(queriesWaitTimeSum, histograms.queriesWait.sum);
        res.observe(
          queriesWaitTimeMean,
          histograms.queriesWait.count > 0
            ? histograms.queriesWait.sum / histograms.queriesWait.count
            : 0
        );
      }

      if (histograms.queriesDuration) {
        res.observe(queriesDurationCount, histograms.queriesDuration.count);
        res.observe(queriesDurationSum, histograms.queriesDuration.sum);
        res.observe(
          queriesDurationMean,
          histograms.queriesDuration.count > 0
            ? histograms.queriesDuration.sum / histograms.queriesDuration.count
            : 0
        );
      }

      if (histograms.datasourceQueriesDuration) {
        res.observe(datasourceQueriesDurationCount, histograms.datasourceQueriesDuration.count);
        res.observe(datasourceQueriesDurationSum, histograms.datasourceQueriesDuration.sum);
        res.observe(
          datasourceQueriesDurationMean,
          histograms.datasourceQueriesDuration.count > 0
            ? histograms.datasourceQueriesDuration.sum / histograms.datasourceQueriesDuration.count
            : 0
        );
      }
    },
    [
      queriesTotal,
      datasourceQueriesTotal,
      connectionsOpenedTotal,
      connectionsClosedTotal,
      queriesActive,
      queriesWait,
      totalGauge,
      busyGauge,
      freeGauge,
      queriesWaitTimeCount,
      queriesWaitTimeSum,
      queriesWaitTimeMean,
      queriesDurationCount,
      queriesDurationSum,
      queriesDurationMean,
      datasourceQueriesDurationCount,
      datasourceQueriesDurationSum,
      datasourceQueriesDurationMean,
    ]
  );
}

function configureNodejsMetrics({ meter }: { meter: Meter }) {
  if (!env.INTERNAL_OTEL_NODEJS_METRICS_ENABLED) {
    return;
  }

  console.log("🔦 Metrics: Node.js runtime metrics enabled (handles, requests, event loop)");

  // UV Threadpool size - based on UV_THREADPOOL_SIZE env var (default 4)
  const uvThreadpoolSizeGauge = meter.createObservableGauge("nodejs.uv_threadpool.size", {
    description: "Size of the libuv threadpool",
    unit: "threads",
  });

  // Active handles - total and by type
  const activeHandlesGauge = meter.createObservableGauge("nodejs.active_handles", {
    description: "Number of active libuv handles grouped by handle type",
    unit: "handles",
  });
  const activeHandlesTotalGauge = meter.createObservableGauge("nodejs.active_handles.total", {
    description: "Total number of active handles",
    unit: "handles",
  });

  // Active requests - total and by type
  const activeRequestsGauge = meter.createObservableGauge("nodejs.active_requests", {
    description: "Number of active libuv requests grouped by request type",
    unit: "requests",
  });
  const activeRequestsTotalGauge = meter.createObservableGauge("nodejs.active_requests.total", {
    description: "Total number of active requests",
    unit: "requests",
  });

  // Event loop lag metrics
  const eventLoopLagMinGauge = meter.createObservableGauge("nodejs.eventloop.lag.min", {
    description: "Event loop minimum delay",
    unit: "s",
  });
  const eventLoopLagMaxGauge = meter.createObservableGauge("nodejs.eventloop.lag.max", {
    description: "Event loop maximum delay",
    unit: "s",
  });
  const eventLoopLagMeanGauge = meter.createObservableGauge("nodejs.eventloop.lag.mean", {
    description: "Event loop mean delay",
    unit: "s",
  });
  const eventLoopLagP50Gauge = meter.createObservableGauge("nodejs.eventloop.lag.p50", {
    description: "Event loop 50th percentile delay",
    unit: "s",
  });
  const eventLoopLagP90Gauge = meter.createObservableGauge("nodejs.eventloop.lag.p90", {
    description: "Event loop 90th percentile delay",
    unit: "s",
  });
  const eventLoopLagP99Gauge = meter.createObservableGauge("nodejs.eventloop.lag.p99", {
    description: "Event loop 99th percentile delay",
    unit: "s",
  });
  // ELU observable gauge (unit is a ratio, 0..1)
  const eluGauge = meter.createObservableGauge("nodejs.event_loop.utilization", {
    description: "Event loop utilization over the last collection interval",
    unit: "1", // OpenTelemetry convention for ratios
  });

  // Get UV threadpool size (defaults to 4 if not set)
  const uvThreadpoolSize = parseInt(process.env.UV_THREADPOOL_SIZE || "4", 10);

  let lastEventLoopUtilization = performance.eventLoopUtilization();

  // Single helper to read metrics from prom-client
  async function readNodeMetrics() {
    const metrics = await metricsRegister.getMetricsAsJSON();

    // Get handle metrics with types
    const activeHandles = metrics.find((m) => m.name === "nodejs_active_handles");
    const activeHandlesTotal = metrics.find((m) => m.name === "nodejs_active_handles_total");

    // Get request metrics with types
    const activeRequests = metrics.find((m) => m.name === "nodejs_active_requests");
    const activeRequestsTotal = metrics.find((m) => m.name === "nodejs_active_requests_total");

    // Event loop metrics
    const eventLoopLagMin = metrics.find((m) => m.name === "nodejs_eventloop_lag_min_seconds");
    const eventLoopLagMax = metrics.find((m) => m.name === "nodejs_eventloop_lag_max_seconds");
    const eventLoopLagMean = metrics.find((m) => m.name === "nodejs_eventloop_lag_mean_seconds");
    const eventLoopLagP50 = metrics.find((m) => m.name === "nodejs_eventloop_lag_p50_seconds");
    const eventLoopLagP90 = metrics.find((m) => m.name === "nodejs_eventloop_lag_p90_seconds");
    const eventLoopLagP99 = metrics.find((m) => m.name === "nodejs_eventloop_lag_p99_seconds");

    // Extract handle types
    const handlesByType: Record<string, number> = {};
    if (activeHandles?.values) {
      for (const value of activeHandles.values) {
        const type = value.labels?.type;
        if (type) {
          handlesByType[type] = value.value;
        }
      }
    }

    // Extract request types
    const requestsByType: Record<string, number> = {};
    if (activeRequests?.values) {
      for (const value of activeRequests.values) {
        const type = value.labels?.type;
        if (type) {
          requestsByType[type] = value.value;
        }
      }
    }

    const currentEventLoopUtilization = performance.eventLoopUtilization();
    // Diff over [lastSnapshot, current]
    const diff = performance.eventLoopUtilization(
      currentEventLoopUtilization,
      lastEventLoopUtilization
    );

    // diff.utilization is between 0 and 1 (fraction of time "active")
    const utilization = Number.isFinite(diff.utilization) ? diff.utilization : 0;

    return {
      threadpoolSize: uvThreadpoolSize,
      handlesByType,
      handlesTotal: activeHandlesTotal?.values?.[0]?.value ?? 0,
      requestsByType,
      requestsTotal: activeRequestsTotal?.values?.[0]?.value ?? 0,
      eventLoop: {
        min: eventLoopLagMin?.values?.[0]?.value ?? 0,
        max: eventLoopLagMax?.values?.[0]?.value ?? 0,
        mean: eventLoopLagMean?.values?.[0]?.value ?? 0,
        p50: eventLoopLagP50?.values?.[0]?.value ?? 0,
        p90: eventLoopLagP90?.values?.[0]?.value ?? 0,
        p99: eventLoopLagP99?.values?.[0]?.value ?? 0,
        utilization,
      },
    };
  }

  meter.addBatchObservableCallback(
    async (res) => {
      const {
        threadpoolSize,
        handlesByType,
        handlesTotal,
        requestsByType,
        requestsTotal,
        eventLoop,
      } = await readNodeMetrics();

      // Observe UV threadpool size
      res.observe(uvThreadpoolSizeGauge, threadpoolSize);

      // Observe handle metrics by type
      for (const [type, count] of Object.entries(handlesByType)) {
        res.observe(activeHandlesGauge, count, { type });
      }
      res.observe(activeHandlesTotalGauge, handlesTotal);

      // Observe request metrics by type
      for (const [type, count] of Object.entries(requestsByType)) {
        res.observe(activeRequestsGauge, count, { type });
      }
      res.observe(activeRequestsTotalGauge, requestsTotal);

      // Observe event loop metrics
      res.observe(eventLoopLagMinGauge, eventLoop.min);
      res.observe(eventLoopLagMaxGauge, eventLoop.max);
      res.observe(eventLoopLagMeanGauge, eventLoop.mean);
      res.observe(eventLoopLagP50Gauge, eventLoop.p50);
      res.observe(eventLoopLagP90Gauge, eventLoop.p90);
      res.observe(eventLoopLagP99Gauge, eventLoop.p99);
      res.observe(eluGauge, eventLoop.utilization);
    },
    [
      uvThreadpoolSizeGauge,
      activeHandlesGauge,
      activeHandlesTotalGauge,
      activeRequestsGauge,
      activeRequestsTotalGauge,
      eventLoopLagMinGauge,
      eventLoopLagMaxGauge,
      eventLoopLagMeanGauge,
      eventLoopLagP50Gauge,
      eventLoopLagP90Gauge,
      eventLoopLagP99Gauge,
      eluGauge,
    ]
  );
}

function configureHostMetrics({ meterProvider }: { meterProvider: MeterProvider }) {
  if (!env.INTERNAL_OTEL_HOST_METRICS_ENABLED) {
    return;
  }

  console.log("🔦 Metrics: Host metrics enabled (CPU, memory, network)");

  const hostMetrics = new HostMetrics({ meterProvider });

  hostMetrics.start();
}

const SemanticEnvResources = {
  ENV_ID: "$trigger.env.id",
  ENV_TYPE: "$trigger.env.type",
  ENV_SLUG: "$trigger.env.slug",
  ORG_ID: "$trigger.org.id",
  ORG_SLUG: "$trigger.org.slug",
  ORG_TITLE: "$trigger.org.title",
  PROJECT_ID: "$trigger.project.id",
  PROJECT_NAME: "$trigger.project.name",
  USER_ID: "$trigger.user.id",
};

export function attributesFromAuthenticatedEnv(env: AuthenticatedEnvironment): Attributes {
  return {
    [SemanticEnvResources.ENV_ID]: env.id,
    [SemanticEnvResources.ENV_TYPE]: env.type,
    [SemanticEnvResources.ENV_SLUG]: env.slug,
    [SemanticEnvResources.ORG_ID]: env.organizationId,
    [SemanticEnvResources.ORG_SLUG]: env.organization.slug,
    [SemanticEnvResources.ORG_TITLE]: env.organization.title,
    [SemanticEnvResources.PROJECT_ID]: env.projectId,
    [SemanticEnvResources.PROJECT_NAME]: env.project.name,
    [SemanticEnvResources.USER_ID]: env.orgMember?.userId,
  };
}

function parseInternalTraceHeaders(): Record<string, string> | undefined {
  try {
    return env.INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADERS
      ? (JSON.parse(env.INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADERS) as Record<string, string>)
      : undefined;
  } catch {
    return;
  }
}

function parseInternalMetricsHeaders(): Record<string, string> | undefined {
  try {
    return env.INTERNAL_OTEL_METRIC_EXPORTER_AUTH_HEADERS
      ? (JSON.parse(env.INTERNAL_OTEL_METRIC_EXPORTER_AUTH_HEADERS) as Record<string, string>)
      : undefined;
  } catch {
    return;
  }
}

function createMetricsExporter() {
  if (env.INTERNAL_OTEL_METRIC_EXPORTER_URL) {
    const headers = parseInternalMetricsHeaders() ?? {};

    console.log(
      `🔦 Tracer: OTLP metric exporter enabled to ${
        env.INTERNAL_OTEL_METRIC_EXPORTER_URL
      } with headers: ${Object.keys(headers)}`
    );

    return new OTLPMetricExporter({
      url: env.INTERNAL_OTEL_METRIC_EXPORTER_URL,
      timeoutMillis: 30_000,
      headers,
    });
  } else {
    console.log(`🔦 Tracer: Compact metric exporter enabled`);
    return new CompactMetricExporter();
  }
}
