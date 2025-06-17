import { LogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { Context } from "@opentelemetry/api";
import { flattenAttributes } from "../utils/flattenAttributes.js";
import { taskContext } from "../task-context-api.js";
import { Tracer } from "@opentelemetry/api";

export class TaskContextSpanProcessor implements SpanProcessor {
  private _innerProcessor: SpanProcessor;
  private _tracer: Tracer;

  constructor(tracer: Tracer, innerProcessor: SpanProcessor) {
    this._tracer = tracer;
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
  onEmit(logRecord: LogRecord, context?: Context | undefined): void {
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
