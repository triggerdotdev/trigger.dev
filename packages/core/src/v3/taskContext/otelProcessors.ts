import { LogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { Context } from "@opentelemetry/api";
import { flattenAttributes } from "../utils/flattenAttributes.js";
import { taskContext } from "../task-context-api.js";

export class TaskContextSpanProcessor implements SpanProcessor {
  private _innerProcessor: SpanProcessor;

  constructor(innerProcessor: SpanProcessor) {
    this._innerProcessor = innerProcessor;
  }

  // Called when a span starts
  onStart(span: Span, parentContext: Context): void {
    if (taskContext.ctx) {
      span.setAttributes(
        flattenAttributes(
          {
            [SemanticInternalAttributes.ATTEMPT_ID]: taskContext.ctx.attempt.id,
            [SemanticInternalAttributes.ATTEMPT_NUMBER]: taskContext.ctx.attempt.number,
          },
          SemanticInternalAttributes.METADATA
        )
      );
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
        flattenAttributes(
          {
            [SemanticInternalAttributes.ATTEMPT_ID]: taskContext.ctx.attempt.id,
            [SemanticInternalAttributes.ATTEMPT_NUMBER]: taskContext.ctx.attempt.number,
          },
          SemanticInternalAttributes.METADATA
        )
      );
    }

    this._innerProcessor.onEmit(logRecord, context);
  }
  shutdown(): Promise<void> {
    return this._innerProcessor.shutdown();
  }
}
