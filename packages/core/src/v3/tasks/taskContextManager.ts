import { Attributes, Context } from "@opentelemetry/api";
import { TaskRunContext, type BackgroundWorkerProperties } from "../schemas";
import { flattenAttributes } from "../utils/flattenAttributes";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage";

type TaskContext = {
  ctx: TaskRunContext;
  worker: BackgroundWorkerProperties;
};

export class TaskContextManager {
  private _storage: SafeAsyncLocalStorage<TaskContext> = new SafeAsyncLocalStorage<TaskContext>();

  get isInsideTask(): boolean {
    return this.#getStore() !== undefined;
  }

  get ctx(): TaskRunContext | undefined {
    const store = this.#getStore();
    return store?.ctx;
  }

  get worker(): BackgroundWorkerProperties | undefined {
    const store = this.#getStore();
    return store?.worker;
  }

  get attributes(): Attributes {
    if (this.ctx) {
      return {
        ...this.contextAttributes,
        ...this.workerAttributes,
      };
    }

    return {};
  }

  get workerAttributes(): Attributes {
    if (this.worker) {
      return {
        [SemanticInternalAttributes.WORKER_ID]: this.worker.id,
        [SemanticInternalAttributes.WORKER_VERSION]: this.worker.version,
      };
    }

    return {};
  }

  get contextAttributes(): Attributes {
    if (this.ctx) {
      return {
        [SemanticInternalAttributes.ATTEMPT_ID]: this.ctx.attempt.id,
        [SemanticInternalAttributes.ATTEMPT_NUMBER]: this.ctx.attempt.number,
        [SemanticInternalAttributes.TASK_SLUG]: this.ctx.task.id,
        [SemanticInternalAttributes.TASK_PATH]: this.ctx.task.filePath,
        [SemanticInternalAttributes.TASK_EXPORT_NAME]: this.ctx.task.exportName,
        [SemanticInternalAttributes.QUEUE_NAME]: this.ctx.queue.name,
        [SemanticInternalAttributes.QUEUE_ID]: this.ctx.queue.id,
        [SemanticInternalAttributes.ENVIRONMENT_ID]: this.ctx.environment.id,
        [SemanticInternalAttributes.ENVIRONMENT_TYPE]: this.ctx.environment.type,
        [SemanticInternalAttributes.ORGANIZATION_ID]: this.ctx.organization.id,
        [SemanticInternalAttributes.PROJECT_ID]: this.ctx.project.id,
        [SemanticInternalAttributes.PROJECT_REF]: this.ctx.project.ref,
        [SemanticInternalAttributes.PROJECT_NAME]: this.ctx.project.name,
        [SemanticInternalAttributes.RUN_ID]: this.ctx.run.id,
        [SemanticInternalAttributes.RUN_IS_TEST]: this.ctx.run.isTest,
        [SemanticInternalAttributes.ORGANIZATION_SLUG]: this.ctx.organization.slug,
        [SemanticInternalAttributes.ORGANIZATION_NAME]: this.ctx.organization.name,
        [SemanticInternalAttributes.BATCH_ID]: this.ctx.batch?.id,
      };
    }

    return {};
  }

  runWith<R extends (...args: any[]) => Promise<any>>(
    context: TaskContext,
    fn: R
  ): Promise<ReturnType<R>> {
    return this._storage.runWith(context, fn);
  }

  #getStore(): TaskContext | undefined {
    return this._storage.getStore();
  }
}

export const taskContextManager = new TaskContextManager();

import { LogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";

export class TaskContextSpanProcessor implements SpanProcessor {
  private _innerProcessor: SpanProcessor;

  constructor(innerProcessor: SpanProcessor) {
    this._innerProcessor = innerProcessor;
  }

  // Called when a span starts
  onStart(span: Span, parentContext: Context): void {
    if (taskContextManager.ctx) {
      span.setAttributes(
        flattenAttributes(
          {
            [SemanticInternalAttributes.ATTEMPT_ID]: taskContextManager.ctx.attempt.id,
            [SemanticInternalAttributes.ATTEMPT_NUMBER]: taskContextManager.ctx.attempt.number,
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
    if (taskContextManager.ctx) {
      logRecord.setAttributes(
        flattenAttributes(
          {
            [SemanticInternalAttributes.ATTEMPT_ID]: taskContextManager.ctx.attempt.id,
            [SemanticInternalAttributes.ATTEMPT_NUMBER]: taskContextManager.ctx.attempt.number,
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
