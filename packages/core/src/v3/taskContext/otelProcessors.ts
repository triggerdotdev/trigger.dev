import { Attributes, Context, trace, Tracer } from "@opentelemetry/api";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type {
  AggregationOption,
  AggregationTemporality,
  InstrumentType,
  MetricData,
  PushMetricExporter,
  ResourceMetrics,
  ScopeMetrics,
} from "@opentelemetry/sdk-metrics";
import { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { taskContext } from "../task-context-api.js";
import { flattenAttributes } from "../utils/flattenAttributes.js";

export class TaskContextSpanProcessor implements SpanProcessor {
  private _innerProcessor: SpanProcessor;
  private _tracer: Tracer;

  constructor(version: string, innerProcessor: SpanProcessor) {
    this._tracer = trace.getTracer("trigger-dev-worker", version);
    this._innerProcessor = innerProcessor;
  }

  // Called when a span starts
  onStart(span: Span, parentContext: Context): void {
    if (taskContext.ctx) {
      span.setAttributes(
        flattenAttributes(taskContext.attributes, SemanticInternalAttributes.METADATA)
      );
    }

    if (!isPartialSpan(span) && !skipPartialSpan(span)) {
      const partialSpan = createPartialSpan(this._tracer, span, parentContext);
      partialSpan.end();
    }

    this._innerProcessor.onStart(span, parentContext);
  }

  // Delegate the rest of the methods to the wrapped processor

  onEnd(span: Span): void {
    this._innerProcessor.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this._innerProcessor.shutdown();
  }

  forceFlush(): Promise<void> {
    return this._innerProcessor.forceFlush();
  }
}

function isPartialSpan(span: Span) {
  return span.attributes[SemanticInternalAttributes.SPAN_PARTIAL] === true;
}

function skipPartialSpan(span: Span) {
  return span.attributes[SemanticInternalAttributes.SKIP_SPAN_PARTIAL] === true;
}

function createPartialSpan(tracer: Tracer, span: Span, parentContext: Context) {
  const partialSpan = tracer.startSpan(
    span.name,
    {
      attributes: {
        [SemanticInternalAttributes.SPAN_PARTIAL]: true,
        [SemanticInternalAttributes.SPAN_ID]: span.spanContext().spanId,
        ...span.attributes,
      },
    },
    parentContext
  );

  if (taskContext.ctx) {
    partialSpan.setAttributes(
      flattenAttributes(taskContext.attributes, SemanticInternalAttributes.METADATA)
    );
  }

  if (span.events) {
    for (const event of span.events) {
      partialSpan.addEvent(event.name, event.attributes, event.time);
    }
  }

  return partialSpan;
}

export class TaskContextLogProcessor implements LogRecordProcessor {
  private _innerProcessor: LogRecordProcessor;

  constructor(innerProcessor: LogRecordProcessor) {
    this._innerProcessor = innerProcessor;
  }
  forceFlush(): Promise<void> {
    return this._innerProcessor.forceFlush();
  }
  onEmit(logRecord: SdkLogRecord, context?: Context | undefined): void {
    // Adds in the context attributes to the log record
    if (taskContext.ctx) {
      logRecord.setAttributes(
        flattenAttributes(taskContext.attributes, SemanticInternalAttributes.METADATA)
      );
    }

    this._innerProcessor.onEmit(logRecord, context);
  }
  shutdown(): Promise<void> {
    return this._innerProcessor.shutdown();
  }
}

export class TaskContextMetricExporter implements PushMetricExporter {
  selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  constructor(private _innerExporter: PushMetricExporter) {
    if (_innerExporter.selectAggregationTemporality) {
      this.selectAggregationTemporality =
        _innerExporter.selectAggregationTemporality.bind(_innerExporter);
    }
    if (_innerExporter.selectAggregation) {
      this.selectAggregation = _innerExporter.selectAggregation.bind(_innerExporter);
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    if (!taskContext.ctx) {
      // No context at all — drop metrics
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const ctx = taskContext.ctx;

    let contextAttrs: Attributes;

    if (taskContext.isRunDisabled) {
      // Between runs: keep environment/project/org/machine attrs, strip run-specific ones
      contextAttrs = {
        [SemanticInternalAttributes.ENVIRONMENT_ID]: ctx.environment.id,
        [SemanticInternalAttributes.ENVIRONMENT_TYPE]: ctx.environment.type,
        [SemanticInternalAttributes.ORGANIZATION_ID]: ctx.organization.id,
        [SemanticInternalAttributes.PROJECT_ID]: ctx.project.id,
        [SemanticInternalAttributes.MACHINE_PRESET_NAME]: ctx.machine?.name,
      };
    } else {
      // During a run: full context attrs
      contextAttrs = {
        [SemanticInternalAttributes.RUN_ID]: ctx.run.id,
        [SemanticInternalAttributes.TASK_SLUG]: ctx.task.id,
        [SemanticInternalAttributes.ATTEMPT_NUMBER]: ctx.attempt.number,
        [SemanticInternalAttributes.ENVIRONMENT_ID]: ctx.environment.id,
        [SemanticInternalAttributes.ORGANIZATION_ID]: ctx.organization.id,
        [SemanticInternalAttributes.PROJECT_ID]: ctx.project.id,
        [SemanticInternalAttributes.MACHINE_PRESET_NAME]: ctx.machine?.name,
        [SemanticInternalAttributes.ENVIRONMENT_TYPE]: ctx.environment.type,
      };
    }

    if (taskContext.worker) {
      contextAttrs[SemanticInternalAttributes.WORKER_ID] = taskContext.worker.id;
      contextAttrs[SemanticInternalAttributes.WORKER_VERSION] = taskContext.worker.version;
    }

    if (!taskContext.isRunDisabled && ctx.run.tags?.length) {
      contextAttrs[SemanticInternalAttributes.RUN_TAGS] = ctx.run.tags;
    }

    const modified: ResourceMetrics = {
      resource: metrics.resource,
      scopeMetrics: metrics.scopeMetrics.map((scope) => ({
        ...scope,
        metrics: scope.metrics.map(
          (metric) =>
            ({
              ...metric,
              dataPoints: metric.dataPoints.map((dp) => ({
                ...dp,
                attributes: { ...dp.attributes, ...contextAttrs },
              })),
            }) as MetricData
        ),
      })),
    };

    this._innerExporter.export(modified, resultCallback);
  }

  forceFlush(): Promise<void> {
    return this._innerExporter.forceFlush();
  }

  shutdown(): Promise<void> {
    return this._innerExporter.shutdown();
  }
}

export class BufferingMetricExporter implements PushMetricExporter {
  selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  private _buffer: ResourceMetrics[] = [];
  private _lastFlushTime = Date.now();

  constructor(
    private _innerExporter: PushMetricExporter,
    private _flushIntervalMs: number
  ) {
    if (_innerExporter.selectAggregationTemporality) {
      this.selectAggregationTemporality =
        _innerExporter.selectAggregationTemporality.bind(_innerExporter);
    }
    if (_innerExporter.selectAggregation) {
      this.selectAggregation = _innerExporter.selectAggregation.bind(_innerExporter);
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this._buffer.push(metrics);

    const now = Date.now();
    if (now - this._lastFlushTime >= this._flushIntervalMs) {
      this._lastFlushTime = now;
      const merged = this._mergeBuffer();
      this._innerExporter.export(merged, resultCallback);
    } else {
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  forceFlush(): Promise<void> {
    if (this._buffer.length > 0) {
      this._lastFlushTime = Date.now();
      const merged = this._mergeBuffer();
      return new Promise<void>((resolve, reject) => {
        this._innerExporter.export(merged, (result) => {
          if (result.code === ExportResultCode.SUCCESS) {
            resolve();
          } else {
            reject(result.error ?? new Error("Export failed"));
          }
        });
      }).then(() => this._innerExporter.forceFlush());
    }
    return this._innerExporter.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.forceFlush().then(() => this._innerExporter.shutdown());
  }

  private _mergeBuffer(): ResourceMetrics {
    const batch = this._buffer;
    this._buffer = [];

    if (batch.length === 1) {
      return batch[0]!;
    }

    const base = batch[0]!;

    // Merge all scopeMetrics by scope name, then metrics by descriptor name
    const scopeMap = new Map<string, { scope: ScopeMetrics["scope"]; metricsMap: Map<string, MetricData> }>();

    for (const rm of batch) {
      for (const sm of rm.scopeMetrics) {
        const scopeKey = sm.scope.name;
        let scopeEntry = scopeMap.get(scopeKey);
        if (!scopeEntry) {
          scopeEntry = { scope: sm.scope, metricsMap: new Map() };
          scopeMap.set(scopeKey, scopeEntry);
        }

        for (const metric of sm.metrics) {
          const metricKey = metric.descriptor.name;
          const existing = scopeEntry.metricsMap.get(metricKey);
          if (existing) {
            // Append data points from this collection to the existing metric
            scopeEntry.metricsMap.set(metricKey, {
              ...existing,
              dataPoints: [...existing.dataPoints, ...metric.dataPoints],
            } as MetricData);
          } else {
            scopeEntry.metricsMap.set(metricKey, {
              ...metric,
              dataPoints: [...metric.dataPoints],
            } as MetricData);
          }
        }
      }
    }

    return {
      resource: base.resource,
      scopeMetrics: Array.from(scopeMap.values()).map(({ scope, metricsMap }) => ({
        scope,
        metrics: Array.from(metricsMap.values()),
      })),
    };
  }
}
