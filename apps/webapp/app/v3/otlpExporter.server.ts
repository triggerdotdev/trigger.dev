import type { Tracer } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import type {
  ExportLogsServiceRequest,
  ExportMetricsServiceRequest,
  ExportTraceServiceRequest,
  ResourceMetrics,
} from "@trigger.dev/otlp-importer";
import {
  ExportLogsServiceResponse,
  ExportMetricsServiceResponse,
  ExportTraceServiceResponse,
} from "@trigger.dev/otlp-importer";
import type { MetricsV1Input } from "@internal/clickhouse";
import { getMeter, type Counter, type Histogram, type Meter } from "@internal/tracing";
import { logger } from "~/services/logger.server";
import type { ClickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { eventRepository } from "./eventRepository/eventRepository.server";
import type { CreateEventInput, IEventRepository } from "./eventRepository/eventRepository.types";
import { startSpan } from "./tracing.server";
import { enrichCreatableEvents } from "./utils/enrichCreatableEvents.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import {
  convertLogsToCreateableEvents,
  convertMetricsToClickhouseRows,
  convertSpansToCreateableEvents,
  isBoolValue,
  isStringValue,
} from "./otlpTransform.server";
import os from "node:os";
import { getOtlpWorkerPool } from "./otlpWorkerPool.server";
import {
  llmPricingRegistry,
  subscribeToPricingReload,
  waitForLlmPricingReady,
} from "./llmPricingRegistry.server";

// When enabled, decode+convert+enrich run in a worker pool; the main thread keeps the single
// consolidated insert path (batching/part-count unchanged). Off = today's single-thread path.
export const otlpTransformWorkerPoolEnabled = env.OTEL_TRANSFORM_WORKER_POOL_ENABLED;

// Always at least 1 worker: a 0/negative override must not silently disable the pool while the
// flag is on (that would hang every raw-export request on an empty pool).
const OTEL_TRANSFORM_WORKER_POOL_SIZE = Math.max(
  1,
  env.OTEL_TRANSFORM_WORKER_POOL_SIZE ?? (os.cpus()?.length ?? 2) - 2
);

type OTLPExporterConfig = {
  clickhouseFactory: ClickhouseFactory;
  verbose: boolean;
  spanAttributeValueLengthLimit: number;
  // Inject in tests; defaults to the global provider. Instruments are no-op when metrics are off.
  meter?: Meter;
};

class OTLPExporter {
  private _tracer: Tracer;
  private readonly _clickhouseFactory: ClickhouseFactory;
  private readonly _verbose: boolean;
  private readonly _spanAttributeValueLengthLimit: number;
  #pricingSubscribed = false;

  private readonly _meter: Meter;
  private readonly _ingestRequests: Counter;
  private readonly _ingestBytes: Counter;
  private readonly _ingestDuration: Histogram;
  private readonly _eventsProduced: Counter;
  private readonly _metricRowsProduced: Counter;

  constructor(config: OTLPExporterConfig) {
    this._tracer = trace.getTracer("otlp-exporter");
    this._clickhouseFactory = config.clickhouseFactory;
    this._verbose = config.verbose;
    this._spanAttributeValueLengthLimit = config.spanAttributeValueLengthLimit;

    this._meter = config.meter ?? getMeter("ingest");
    this._ingestRequests = this._meter.createCounter("ingest.requests", {
      description: "OTLP export calls received, by signal / path / outcome",
      unit: "requests",
    });
    this._ingestBytes = this._meter.createCounter("ingest.bytes", {
      description: "Compressed protobuf payload bytes received",
      unit: "By",
    });
    this._ingestDuration = this._meter.createHistogram("ingest.duration", {
      description: "End-to-end time to handle an OTLP export call",
      unit: "ms",
    });
    this._eventsProduced = this._meter.createCounter("ingest.events.produced", {
      description: "Task events produced from spans/logs after filter + convert",
      unit: "events",
    });
    this._metricRowsProduced = this._meter.createCounter("ingest.metric_rows.produced", {
      description: "ClickHouse metric rows produced from OTLP metrics",
      unit: "rows",
    });
  }

  // One helper for both the worker (mode="worker") and inline (mode="inline") paths. Called once
  // per export call, so building the small attribute objects here is not a hot-path allocation.
  #recordIngest(kind: string, mode: string, outcome: string, startedAt: number): void {
    this._ingestRequests.add(1, { kind, mode, outcome });
    this._ingestDuration.record(Date.now() - startedAt, { kind, mode });
  }

  async exportTraces(request: ExportTraceServiceRequest): Promise<ExportTraceServiceResponse> {
    return await startSpan(this._tracer, "exportTraces", async (span) => {
      const startedAt = Date.now();
      try {
        this.#logExportTracesVerbose(request);

        const eventsWithStores = this.#filterResourceSpans(request.resourceSpans).flatMap(
          (resourceSpan) => {
            return convertSpansToCreateableEvents(
              resourceSpan,
              this._spanAttributeValueLengthLimit,
              env.EVENT_REPOSITORY_DEFAULT_STORE
            );
          }
        );

        const eventCount = await this.#exportEvents(eventsWithStores);

        span.setAttribute("event_count", eventCount);
        this._eventsProduced.add(eventCount, { kind: "traces" });
        this.#recordIngest("traces", "inline", "ok", startedAt);

        return ExportTraceServiceResponse.create();
      } catch (error) {
        this.#recordIngest("traces", "inline", "error", startedAt);
        throw error;
      }
    });
  }

  async exportMetrics(request: ExportMetricsServiceRequest): Promise<ExportMetricsServiceResponse> {
    return await startSpan(this._tracer, "exportMetrics", async (span) => {
      const startedAt = Date.now();
      try {
        const rows = this.#filterResourceMetrics(request.resourceMetrics).flatMap(
          (resourceMetrics) =>
            convertMetricsToClickhouseRows(resourceMetrics, this._spanAttributeValueLengthLimit)
        );

        span.setAttribute("metric_row_count", rows.length);

        if (rows.length > 0) {
          await this.#exportMetricRows(rows);
        }

        this._metricRowsProduced.add(rows.length, { kind: "metrics" });
        this.#recordIngest("metrics", "inline", "ok", startedAt);

        return ExportMetricsServiceResponse.create();
      } catch (error) {
        this.#recordIngest("metrics", "inline", "error", startedAt);
        throw error;
      }
    });
  }

  async exportLogs(request: ExportLogsServiceRequest): Promise<ExportLogsServiceResponse> {
    return await startSpan(this._tracer, "exportLogs", async (span) => {
      const startedAt = Date.now();
      try {
        this.#logExportLogsVerbose(request);

        const eventsWithStores = this.#filterResourceLogs(request.resourceLogs).flatMap(
          (resourceLog) => {
            return convertLogsToCreateableEvents(
              resourceLog,
              this._spanAttributeValueLengthLimit,
              env.EVENT_REPOSITORY_DEFAULT_STORE
            );
          }
        );

        const eventCount = await this.#exportEvents(eventsWithStores);

        span.setAttribute("event_count", eventCount);
        this._eventsProduced.add(eventCount, { kind: "logs" });
        this.#recordIngest("logs", "inline", "ok", startedAt);

        return ExportLogsServiceResponse.create();
      } catch (error) {
        this.#recordIngest("logs", "inline", "error", startedAt);
        throw error;
      }
    });
  }

  async exportTracesRaw(payload: Uint8Array): Promise<void> {
    await this.#exportRawEvents("traces", payload);
  }

  async exportLogsRaw(payload: Uint8Array): Promise<void> {
    await this.#exportRawEvents("logs", payload);
  }

  async exportMetricsRaw(payload: Uint8Array): Promise<void> {
    await startSpan(this._tracer, "exportMetricsRaw", async (span) => {
      const startedAt = Date.now();
      this._ingestBytes.add(payload.byteLength, { kind: "metrics" });
      try {
        const pool = await this.#pool();
        const { rows } = await pool.runTransform("metrics", payload, this.#transformConfig());
        span.setAttribute("metric_row_count", rows.length);
        if (rows.length > 0) {
          await this.#exportMetricRows(rows);
        }
        this._metricRowsProduced.add(rows.length, { kind: "metrics" });
        this.#recordIngest("metrics", "worker", "ok", startedAt);
      } catch (error) {
        this.#recordIngest("metrics", "worker", "error", startedAt);
        throw error;
      }
    });
  }

  async #exportRawEvents(kind: "traces" | "logs", payload: Uint8Array): Promise<void> {
    await startSpan(
      this._tracer,
      kind === "traces" ? "exportTracesRaw" : "exportLogsRaw",
      async (span) => {
        const startedAt = Date.now();
        this._ingestBytes.add(payload.byteLength, { kind });
        try {
          const pool = await this.#pool();
          const { eventsWithStores } = await pool.runTransform(
            kind,
            payload,
            this.#transformConfig()
          );
          const eventCount = await this.#exportEvents(eventsWithStores, true);
          span.setAttribute("event_count", eventCount);
          this._eventsProduced.add(eventCount, { kind });
          this.#recordIngest(kind, "worker", "ok", startedAt);
        } catch (error) {
          this.#recordIngest(kind, "worker", "error", startedAt);
          throw error;
        }
      }
    );
  }

  #transformConfig() {
    return {
      spanAttributeValueLengthLimit: this._spanAttributeValueLengthLimit,
      defaultEventStore: env.EVENT_REPOSITORY_DEFAULT_STORE,
    };
  }

  async #pool() {
    await waitForLlmPricingReady();
    const models =
      llmPricingRegistry && llmPricingRegistry.isLoaded ? llmPricingRegistry.toSerializable() : [];
    const pool = getOtlpWorkerPool(
      OTEL_TRANSFORM_WORKER_POOL_SIZE,
      models,
      env.OTEL_TRANSFORM_WORKER_PATH,
      this._meter
    );
    if (!this.#pricingSubscribed) {
      this.#pricingSubscribed = true;
      // Re-broadcast pricing to workers on every registry reload so their cost math stays fresh.
      subscribeToPricingReload((updated) => pool.broadcastPricing(updated));
    }
    return pool;
  }

  async #exportEvents(
    eventsWithStores: { events: Array<CreateEventInput>; taskEventStore: string }[],
    alreadyEnriched = false
  ) {
    if (!alreadyEnriched) {
      await waitForLlmPricingReady();
    }

    // Group by unique event repositories
    const routeCache = new Map<string, { key: string; repository: IEventRepository }>();
    const groups = new Map<string, { repository: IEventRepository; events: CreateEventInput[] }>();
    for (const { events, taskEventStore } of eventsWithStores) {
      for (const event of events) {
        const routeKey = `${event.organizationId}\0${taskEventStore}`;
        let resolved = routeCache.get(routeKey);
        if (!resolved) {
          // Non-ClickHouse stores (taskEvent / taskEventPartitioned) are Postgres-backed.
          // The ClickHouse factory only handles clickhouse/clickhouse_v2 and throws otherwise.
          if (taskEventStore !== "clickhouse" && taskEventStore !== "clickhouse_v2") {
            // Non-ClickHouse stores (taskEvent / taskEventPartitioned) are Postgres-backed.
            // The ClickHouse factory only handles clickhouse/clickhouse_v2 and throws otherwise.
            resolved = { key: "postgres:default", repository: eventRepository };
          } else {
            resolved = this._clickhouseFactory.getEventRepositoryForOrganizationSync(
              taskEventStore,
              event.organizationId
            );
          }
          routeCache.set(routeKey, resolved);
        }

        let group = groups.get(resolved.key);
        if (!group) {
          group = { repository: resolved.repository, events: [] };
          groups.set(resolved.key, group);
        }
        group.events.push(event);
      }
    }

    let eventCount = 0;

    for (const [repoKey, { repository, events }] of groups) {
      const enrichedEvents = alreadyEnriched ? events : enrichCreatableEvents(events);

      this.#logEventsVerbose(enrichedEvents, `exportEvents ${repoKey}`);

      eventCount += enrichedEvents.length;

      repository.insertMany(enrichedEvents);
    }

    return eventCount;
  }

  async #exportMetricRows(rows: MetricsV1Input[]): Promise<void> {
    const routeCache = new Map<string, { key: string; repository: IEventRepository }>();
    const groups = new Map<string, { repository: IEventRepository; rows: MetricsV1Input[] }>();

    for (const row of rows) {
      const routeKey = row.organization_id;
      let resolved = routeCache.get(routeKey);
      if (!resolved) {
        resolved = this._clickhouseFactory.getEventRepositoryForOrganizationSync(
          "clickhouse_v2",
          row.organization_id
        );
        routeCache.set(routeKey, resolved);
      }

      let group = groups.get(resolved.key);
      if (!group) {
        group = { repository: resolved.repository, rows: [] };
        groups.set(resolved.key, group);
      }
      group.rows.push(row);
    }

    for (const [, { repository, rows: groupedRows }] of groups) {
      repository.insertManyMetrics(groupedRows);
    }
  }

  #logEventsVerbose(events: CreateEventInput[], prefix: string) {
    if (!this._verbose) return;

    events.forEach((event) => {
      logger.debug(`Exporting ${prefix} event`, { event });
    });
  }

  #logExportTracesVerbose(request: ExportTraceServiceRequest) {
    if (!this._verbose) return;

    logger.debug("Exporting traces", {
      resourceSpans: request.resourceSpans.length,
      totalSpans: request.resourceSpans.reduce(
        (acc, resourceSpan) => acc + resourceSpan.scopeSpans.length,
        0
      ),
    });
  }

  #logExportLogsVerbose(request: ExportLogsServiceRequest) {
    if (!this._verbose) return;

    logger.debug("Exporting logs", {
      resourceLogs: request.resourceLogs.length,
      totalLogs: request.resourceLogs.reduce(
        (acc, resourceLog) =>
          acc +
          resourceLog.scopeLogs.reduce((acc, scopeLog) => acc + scopeLog.logRecords.length, 0),
        0
      ),
    });
  }

  #filterResourceSpans(
    resourceSpans: ExportTraceServiceRequest["resourceSpans"]
  ): ExportTraceServiceRequest["resourceSpans"] {
    return resourceSpans.filter((resourceSpan) => {
      const triggerAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      const executionEnvironmentAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.EXECUTION_ENVIRONMENT
      );

      if (!triggerAttribute && !executionEnvironmentAttribute) {
        logger.debug("Skipping resource span without trigger attribute", {
          attributes: resourceSpan.resource?.attributes,
          spans: resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
        });

        return true; // go ahead and let this resource span through
      }

      const executionEnvironment = isStringValue(executionEnvironmentAttribute?.value)
        ? executionEnvironmentAttribute.value.stringValue
        : undefined;

      if (executionEnvironment === "trigger") {
        return true; // go ahead and let this resource span through
      }

      return isBoolValue(triggerAttribute?.value) ? triggerAttribute.value.boolValue : false;
    });
  }

  #filterResourceLogs(
    resourceLogs: ExportLogsServiceRequest["resourceLogs"]
  ): ExportLogsServiceRequest["resourceLogs"] {
    return resourceLogs.filter((resourceLog) => {
      const attribute = resourceLog.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      if (!attribute) return false;

      return isBoolValue(attribute.value) ? attribute.value.boolValue : false;
    });
  }

  #filterResourceMetrics(resourceMetrics: ResourceMetrics[]): ResourceMetrics[] {
    return resourceMetrics.filter((rm) => {
      const triggerAttribute = rm.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      if (!triggerAttribute) return false;

      return isBoolValue(triggerAttribute.value) ? triggerAttribute.value.boolValue : false;
    });
  }
}

export const otlpExporter = singleton("otlpExporter", initializeOTLPExporter);

async function initializeOTLPExporter() {
  await clickhouseFactory.isReady();
  return new OTLPExporter({
    clickhouseFactory,
    verbose: process.env.OTLP_EXPORTER_VERBOSE === "1",
    spanAttributeValueLengthLimit: process.env.SERVER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT
      ? parseInt(process.env.SERVER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT, 10)
      : 8192,
  });
}
