import { SpanKind } from "@opentelemetry/api";
import { VERSION } from "../../version.js";
import { ApiError, RateLimitError } from "../apiClient/errors.js";
import { ConsoleInterceptor } from "../consoleInterceptor.js";
import { isInternalError, parseError, sanitizeError, TaskPayloadParsedError } from "../errors.js";
import { flattenAttributes, lifecycleHooks, runMetadata, waitUntil } from "../index.js";
import {
  AnyOnMiddlewareHookFunction,
  RegisteredHookFunction,
  TaskCompleteResult,
  TaskInitOutput,
} from "../lifecycleHooks/types.js";
import { recordSpanException, TracingSDK } from "../otel/index.js";
import { runTimelineMetrics } from "../run-timeline-metrics-api.js";
import {
  RetryOptions,
  ServerBackgroundWorker,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunExecutionRetry,
} from "../schemas/index.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { taskContext } from "../task-context-api.js";
import { TriggerTracer } from "../tracer.js";
import {
  HandleErrorFunction,
  HandleErrorModificationOptions,
  TaskMetadataWithFunctions,
} from "../types/index.js";
import {
  conditionallyExportPacket,
  conditionallyImportPacket,
  createPacketAttributes,
  parsePacket,
  stringifyIO,
} from "../utils/ioSerialization.js";
import { calculateNextRetryDelay } from "../utils/retries.js";
import { tryCatch } from "../tryCatch.js";

export type TaskExecutorOptions = {
  tracingSDK: TracingSDK;
  tracer: TriggerTracer;
  consoleInterceptor: ConsoleInterceptor;
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };
  handleErrorFn: HandleErrorFunction | undefined;
};

export class TaskExecutor {
  private _tracingSDK: TracingSDK;
  private _tracer: TriggerTracer;
  private _consoleInterceptor: ConsoleInterceptor;
  private _retries:
    | {
        enabledInDev?: boolean;
        default?: RetryOptions;
      }
    | undefined;
  private _handleErrorFn: HandleErrorFunction | undefined;

  constructor(
    public task: TaskMetadataWithFunctions,
    options: TaskExecutorOptions
  ) {
    this._tracingSDK = options.tracingSDK;
    this._tracer = options.tracer;
    this._consoleInterceptor = options.consoleInterceptor;
    this._retries = options.retries;
    this._handleErrorFn = options.handleErrorFn;
  }

  async execute(
    execution: TaskRunExecution,
    worker: ServerBackgroundWorker,
    traceContext: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ result: TaskRunExecutionResult }> {
    const ctx = TaskRunContext.parse(execution);
    const attemptMessage = `Attempt ${execution.attempt.number}`;

    const originalPacket = {
      data: execution.run.payload,
      dataType: execution.run.payloadType,
    };

    taskContext.setGlobalTaskContext({
      ctx,
      worker,
    });

    if (execution.run.metadata) {
      runMetadata.enterWithMetadata(execution.run.metadata);
    }

    this._tracingSDK.asyncResourceDetector.resolveWithAttributes({
      ...taskContext.attributes,
      [SemanticInternalAttributes.SDK_VERSION]: VERSION,
      [SemanticInternalAttributes.SDK_LANGUAGE]: "typescript",
    });

    const result = await this._tracer.startActiveSpan(
      attemptMessage,
      async (span) => {
        return await this._consoleInterceptor.intercept(console, async () => {
          let parsedPayload: any;
          let initOutput: any;

          const [inputError, payloadResult] = await tryCatch(
            runTimelineMetrics.measureMetric("trigger.dev/execution", "payload", async () => {
              const payloadPacket = await conditionallyImportPacket(originalPacket, this._tracer);
              return await parsePacket(payloadPacket);
            })
          );

          if (inputError) {
            recordSpanException(span, inputError);
            return this.#internalErrorResult(
              execution,
              TaskRunErrorCodes.TASK_INPUT_ERROR,
              inputError
            );
          }

          parsedPayload = await this.#parsePayload(payloadResult);

          const executeTask = async (payload: any) => {
            const [runError, output] = await tryCatch(
              (async () => {
                initOutput = await this.#callInitFunctions(payload, ctx, signal);

                if (execution.attempt.number === 1) {
                  await this.#callOnStartFunctions(payload, ctx, initOutput, signal);
                }

                return await this.#callRun(payload, ctx, initOutput, signal);
              })()
            );

            if (runError) {
              const [handleErrorError, handleErrorResult] = await tryCatch(
                this.#handleError(execution, runError, payload, ctx, initOutput, signal)
              );

              if (handleErrorError) {
                recordSpanException(span, handleErrorError);
                return this.#internalErrorResult(
                  execution,
                  TaskRunErrorCodes.HANDLE_ERROR_ERROR,
                  handleErrorError
                );
              }

              recordSpanException(span, handleErrorResult.error ?? runError);

              if (handleErrorResult.status !== "retry") {
                await this.#callOnFailureFunctions(
                  payload,
                  handleErrorResult.error ?? runError,
                  ctx,
                  initOutput,
                  signal
                );

                await this.#callOnCompleteFunctions(
                  payload,
                  { ok: false, error: handleErrorResult.error ?? runError },
                  ctx,
                  initOutput,
                  signal
                );
              }

              await this.#cleanupAndWaitUntil(payload, ctx, initOutput, signal);

              return {
                id: execution.run.id,
                ok: false,
                error: sanitizeError(
                  handleErrorResult.error
                    ? parseError(handleErrorResult.error)
                    : parseError(runError)
                ),
                retry: handleErrorResult.status === "retry" ? handleErrorResult.retry : undefined,
                skippedRetrying: handleErrorResult.status === "skipped",
              } satisfies TaskRunExecutionResult;
            }

            const [outputError, stringifiedOutput] = await tryCatch(stringifyIO(output));

            if (outputError) {
              recordSpanException(span, outputError);
              await this.#cleanupAndWaitUntil(payload, ctx, initOutput, signal);

              return this.#internalErrorResult(
                execution,
                TaskRunErrorCodes.TASK_OUTPUT_ERROR,
                outputError
              );
            }

            const [exportError, finalOutput] = await tryCatch(
              conditionallyExportPacket(
                stringifiedOutput,
                `${execution.attempt.id}/output`,
                this._tracer
              )
            );

            if (exportError) {
              recordSpanException(span, exportError);
              await this.#cleanupAndWaitUntil(payload, ctx, initOutput, signal);

              return this.#internalErrorResult(
                execution,
                TaskRunErrorCodes.TASK_OUTPUT_ERROR,
                exportError
              );
            }

            const [attrError, attributes] = await tryCatch(
              createPacketAttributes(
                finalOutput,
                SemanticInternalAttributes.OUTPUT,
                SemanticInternalAttributes.OUTPUT_TYPE
              )
            );

            if (!attrError && attributes) {
              span.setAttributes(attributes);
            }

            await this.#callOnSuccessFunctions(payload, output, ctx, initOutput, signal);
            await this.#callOnCompleteFunctions(
              payload,
              { ok: true, data: output },
              ctx,
              initOutput,
              signal
            );

            await this.#cleanupAndWaitUntil(payload, ctx, initOutput, signal);

            return {
              ok: true,
              id: execution.run.id,
              output: finalOutput.data,
              outputType: finalOutput.dataType,
            } satisfies TaskRunExecutionResult;
          };

          const globalMiddlewareHooks = lifecycleHooks.getGlobalMiddlewareHooks();
          const taskMiddlewareHook = lifecycleHooks.getTaskMiddlewareHook(this.task.id);

          const middlewareHooks = [
            ...globalMiddlewareHooks,
            taskMiddlewareHook ? { id: this.task.id, fn: taskMiddlewareHook } : undefined,
          ].filter(Boolean) as RegisteredHookFunction<AnyOnMiddlewareHookFunction>[];

          return await this.#executeTaskWithMiddlewareHooks(
            parsedPayload,
            ctx,
            execution,
            middlewareHooks,
            executeTask,
            signal
          );
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "attempt",
          [SemanticInternalAttributes.SPAN_ATTEMPT]: true,
          ...(execution.attempt.number === 1
            ? runTimelineMetrics.convertMetricsToSpanAttributes()
            : {}),
        },
        events:
          execution.attempt.number === 1
            ? runTimelineMetrics.convertMetricsToSpanEvents()
            : undefined,
      },
      this._tracer.extractContext(traceContext),
      signal
    );

    return { result };
  }

  async #executeTaskWithMiddlewareHooks(
    payload: unknown,
    ctx: TaskRunContext,
    execution: TaskRunExecution,
    hooks: RegisteredHookFunction<AnyOnMiddlewareHookFunction>[],
    executeTask: (payload: unknown) => Promise<TaskRunExecutionResult>,
    signal?: AbortSignal
  ) {
    let output: any;
    let executeError: unknown;

    const runner = hooks.reduceRight(
      (next, hook) => {
        return async () => {
          await hook.fn({ payload, ctx, signal, task: this.task.id, next });
        };
      },
      async () => {
        const [error, result] = await tryCatch(executeTask(payload));
        if (error) {
          executeError = error;
        } else {
          output = result;
        }
      }
    );

    const [runnerError] = await tryCatch(runner());
    if (runnerError) {
      return this.#internalErrorResult(
        execution,
        TaskRunErrorCodes.TASK_MIDDLEWARE_ERROR,
        runnerError
      );
    }

    if (executeError) {
      throw executeError;
    }

    return output;
  }

  async #callRun(payload: unknown, ctx: TaskRunContext, init: unknown, signal?: AbortSignal) {
    const runFn = this.task.fns.run;

    if (!runFn) {
      throw new Error("Task does not have a run function");
    }

    return runTimelineMetrics.measureMetric("trigger.dev/execution", "run", () =>
      runFn(payload, { ctx, init, signal })
    );
  }

  async #callInitFunctions(payload: unknown, ctx: TaskRunContext, signal?: AbortSignal) {
    const globalInitHooks = lifecycleHooks.getGlobalInitHooks();
    const taskInitHook = lifecycleHooks.getTaskInitHook(this.task.id);

    if (globalInitHooks.length === 0 && !taskInitHook) {
      return {};
    }

    return this._tracer.startActiveSpan(
      "hooks.init",
      async (span) => {
        const result = await runTimelineMetrics.measureMetric(
          "trigger.dev/execution",
          "init",
          async () => {
            // Store global hook results in an array
            const globalResults = [];
            for (const hook of globalInitHooks) {
              const [hookError, result] = await tryCatch(
                this._tracer.startActiveSpan(
                  hook.name ?? "global",
                  async (span) => {
                    const result = await hook.fn({ payload, ctx, signal, task: this.task.id });

                    if (result && typeof result === "object" && !Array.isArray(result)) {
                      span.setAttributes(flattenAttributes(result));
                      return result;
                    }

                    return {};
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );

              if (hookError) {
                throw hookError;
              }

              if (result && typeof result === "object" && !Array.isArray(result)) {
                globalResults.push(result);
              }
            }

            // Merge all global results into a single object
            const mergedGlobalResults = Object.assign({}, ...globalResults);

            if (taskInitHook) {
              const [hookError, taskResult] = await tryCatch(
                this._tracer.startActiveSpan(
                  "task",
                  async (span) => {
                    const result = await taskInitHook({ payload, ctx, signal, task: this.task.id });

                    if (result && typeof result === "object" && !Array.isArray(result)) {
                      span.setAttributes(flattenAttributes(result));
                      return result;
                    }

                    return {};
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );

              if (hookError) {
                throw hookError;
              }

              // Only merge if taskResult is an object
              if (taskResult && typeof taskResult === "object" && !Array.isArray(taskResult)) {
                return { ...mergedGlobalResults, ...taskResult };
              }

              // If taskResult isn't an object, return global results
              return mergedGlobalResults;
            }

            return mergedGlobalResults;
          }
        );

        if (result && typeof result === "object" && !Array.isArray(result)) {
          span.setAttributes(flattenAttributes(result));
          return result;
        }

        return;
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
          [SemanticInternalAttributes.COLLAPSED]: true,
        },
      }
    );
  }

  async #callOnSuccessFunctions(
    payload: unknown,
    output: any,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    const globalSuccessHooks = lifecycleHooks.getGlobalSuccessHooks();
    const taskSuccessHook = lifecycleHooks.getTaskSuccessHook(this.task.id);

    if (globalSuccessHooks.length === 0 && !taskSuccessHook) {
      return;
    }

    return this._tracer.startActiveSpan(
      "hooks.success",
      async (span) => {
        return await runTimelineMetrics.measureMetric(
          "trigger.dev/execution",
          "success",
          async () => {
            for (const hook of globalSuccessHooks) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  hook.name ?? "global",
                  async (span) => {
                    await hook.fn({
                      payload,
                      output,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from onSuccess functions
            }

            if (taskSuccessHook) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  "task",
                  async (span) => {
                    await taskSuccessHook({
                      payload,
                      output,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from onSuccess functions
            }
          }
        );
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
        },
      }
    );
  }

  async #callOnFailureFunctions(
    payload: unknown,
    error: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    const globalFailureHooks = lifecycleHooks.getGlobalFailureHooks();
    const taskFailureHook = lifecycleHooks.getTaskFailureHook(this.task.id);

    if (globalFailureHooks.length === 0 && !taskFailureHook) {
      return;
    }

    return this._tracer.startActiveSpan(
      "hooks.failure",
      async (span) => {
        return await runTimelineMetrics.measureMetric(
          "trigger.dev/execution",
          "failure",
          async () => {
            for (const hook of globalFailureHooks) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  hook.name ?? "global",
                  async (span) => {
                    await hook.fn({
                      payload,
                      error,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from onFailure functions
            }

            if (taskFailureHook) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  "task",
                  async (span) => {
                    await taskFailureHook({
                      payload,
                      error,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from onFailure functions
            }
          }
        );
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
        },
      }
    );
  }

  async #parsePayload(payload: unknown) {
    if (!this.task.fns.parsePayload) {
      return payload;
    }

    const [parseError, result] = await tryCatch(this.task.fns.parsePayload(payload));
    if (parseError) {
      throw new TaskPayloadParsedError(parseError);
    }
    return result;
  }

  async #callOnStartFunctions(
    payload: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    const globalStartHooks = lifecycleHooks.getGlobalStartHooks();
    const taskStartHook = lifecycleHooks.getTaskStartHook(this.task.id);

    if (globalStartHooks.length === 0 && !taskStartHook) {
      return;
    }

    return this._tracer.startActiveSpan(
      "hooks.start",
      async (span) => {
        return await runTimelineMetrics.measureMetric(
          "trigger.dev/execution",
          "start",
          async () => {
            for (const hook of globalStartHooks) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  hook.name ?? "global",
                  async (span) => {
                    await hook.fn({ payload, ctx, signal, task: this.task.id, init: initOutput });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );

              if (hookError) {
                throw hookError;
              }
            }

            if (taskStartHook) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  "task",
                  async (span) => {
                    await taskStartHook({
                      payload,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );

              if (hookError) {
                throw hookError;
              }
            }
          }
        );
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
        },
      }
    );
  }

  async #cleanupAndWaitUntil(
    payload: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    await this.#callCleanupFunctions(payload, ctx, initOutput, signal);
    await this.#blockForWaitUntil();
  }

  async #callCleanupFunctions(
    payload: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    const globalCleanupHooks = lifecycleHooks.getGlobalCleanupHooks();
    const taskCleanupHook = lifecycleHooks.getTaskCleanupHook(this.task.id);

    if (globalCleanupHooks.length === 0 && !taskCleanupHook) {
      return;
    }

    return this._tracer.startActiveSpan(
      "hooks.cleanup",
      async (span) => {
        return await runTimelineMetrics.measureMetric(
          "trigger.dev/execution",
          "cleanup",
          async () => {
            for (const hook of globalCleanupHooks) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  hook.name ?? "global",
                  async (span) => {
                    await hook.fn({
                      payload,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from cleanup functions
            }

            if (taskCleanupHook) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  "task",
                  async (span) => {
                    await taskCleanupHook({
                      payload,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from cleanup functions
            }
          }
        );
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
        },
      }
    );
  }

  async #blockForWaitUntil() {
    if (!waitUntil.requiresResolving()) {
      return;
    }

    return this._tracer.startActiveSpan(
      "waitUntil",
      async (span) => {
        return await waitUntil.blockUntilSettled(60_000);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "clock",
        },
      }
    );
  }

  async #handleError(
    execution: TaskRunExecution,
    error: unknown,
    payload: any,
    ctx: TaskRunContext,
    init: TaskInitOutput,
    signal?: AbortSignal
  ): Promise<
    | { status: "retry"; retry: TaskRunExecutionRetry; error?: unknown }
    | { status: "skipped"; error?: unknown }
    | { status: "noop"; error?: unknown }
  > {
    const retriesConfig = this._retries;
    const retry = this.task.retry ?? retriesConfig?.default;

    // Early exit conditions that prevent retrying
    if (isInternalError(error) && error.skipRetrying) {
      return { status: "skipped", error };
    }

    if (
      error instanceof Error &&
      (error.name === "AbortTaskRunError" || error.name === "TaskPayloadParsedError")
    ) {
      return { status: "skipped" };
    }

    // Calculate default retry delay if retry config exists
    let defaultDelay: number | undefined;
    if (retry) {
      if (execution.run.maxAttempts) {
        retry.maxAttempts = Math.max(execution.run.maxAttempts, 1);
      }

      defaultDelay = calculateNextRetryDelay(retry, execution.attempt.number);

      // Handle rate limit errors
      if (
        defaultDelay &&
        error instanceof Error &&
        error.name === "TriggerApiError" &&
        (error as ApiError).status === 429
      ) {
        const rateLimitError = error as RateLimitError;
        defaultDelay = rateLimitError.millisecondsUntilReset;
      }
    }

    // Check if retries are enabled in dev environment
    if (
      execution.environment.type === "DEVELOPMENT" &&
      typeof retriesConfig?.enabledInDev === "boolean" &&
      !retriesConfig.enabledInDev
    ) {
      return { status: "skipped" };
    }

    return this._tracer.startActiveSpan(
      "handleError()",
      async (span) => {
        // Try task-specific catch error hook first
        const taskCatchErrorHook = lifecycleHooks.getTaskCatchErrorHook(this.task.id);
        if (taskCatchErrorHook) {
          const result = await taskCatchErrorHook({
            payload,
            error,
            ctx,
            init,
            retry,
            retryDelayInMs: defaultDelay,
            retryAt: defaultDelay ? new Date(Date.now() + defaultDelay) : undefined,
            signal,
            task: this.task.id,
          });

          if (result) {
            return this.#processHandleErrorResult(result, execution.attempt.number, defaultDelay);
          }
        }

        // Try global catch error hooks in order
        const globalCatchErrorHooks = lifecycleHooks.getGlobalCatchErrorHooks();
        for (const hook of globalCatchErrorHooks) {
          const result = await hook.fn({
            payload,
            error,
            ctx,
            init,
            retry,
            retryDelayInMs: defaultDelay,
            retryAt: defaultDelay ? new Date(Date.now() + defaultDelay) : undefined,
            signal,
            task: this.task.id,
          });

          if (result) {
            return this.#processHandleErrorResult(result, execution.attempt.number, defaultDelay);
          }
        }

        // If no hooks handled the error, use default retry behavior
        return typeof defaultDelay === "undefined"
          ? { status: "noop" as const }
          : {
              status: "retry" as const,
              retry: { timestamp: Date.now() + defaultDelay, delay: defaultDelay },
            };
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "exclamation-circle",
        },
      }
    );
  }

  // Helper method to process handle error results
  #processHandleErrorResult(
    result: HandleErrorModificationOptions,
    attemptNumber: number,
    defaultDelay?: number
  ):
    | { status: "retry"; retry: TaskRunExecutionRetry; error?: unknown }
    | { status: "skipped"; error?: unknown }
    | { status: "noop"; error?: unknown } {
    if (result.skipRetrying) {
      return { status: "skipped", error: result.error };
    }

    if (typeof result.retryAt !== "undefined") {
      return {
        status: "retry",
        retry: {
          timestamp: result.retryAt.getTime(),
          delay: result.retryAt.getTime() - Date.now(),
        },
        error: result.error,
      };
    }

    if (typeof result.retryDelayInMs === "number") {
      return {
        status: "retry",
        retry: {
          timestamp: Date.now() + result.retryDelayInMs,
          delay: result.retryDelayInMs,
        },
        error: result.error,
      };
    }

    if (result.retry && typeof result.retry === "object") {
      const delay = calculateNextRetryDelay(result.retry, attemptNumber);

      return typeof delay === "undefined"
        ? { status: "noop", error: result.error }
        : {
            status: "retry",
            retry: { timestamp: Date.now() + delay, delay },
            error: result.error,
          };
    }

    return { status: "noop", error: result.error };
  }

  async #callOnCompleteFunctions(
    payload: unknown,
    result: TaskCompleteResult<unknown>,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    const globalCompleteHooks = lifecycleHooks.getGlobalCompleteHooks();
    const taskCompleteHook = lifecycleHooks.getTaskCompleteHook(this.task.id);

    if (globalCompleteHooks.length === 0 && !taskCompleteHook) {
      return;
    }

    return this._tracer.startActiveSpan(
      "hooks.complete",
      async (span) => {
        return await runTimelineMetrics.measureMetric(
          "trigger.dev/execution",
          "complete",
          async () => {
            for (const hook of globalCompleteHooks) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  hook.name ?? "global",
                  async (span) => {
                    await hook.fn({
                      payload,
                      result,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from onComplete functions
            }

            if (taskCompleteHook) {
              const [hookError] = await tryCatch(
                this._tracer.startActiveSpan(
                  "task",
                  async (span) => {
                    await taskCompleteHook({
                      payload,
                      result,
                      ctx,
                      signal,
                      task: this.task.id,
                      init: initOutput,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
                    },
                  }
                )
              );
              // Ignore errors from onComplete functions
            }
          }
        );
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "tabler-function",
        },
      }
    );
  }

  #internalErrorResult(execution: TaskRunExecution, code: TaskRunErrorCodes, error: unknown) {
    return {
      ok: false,
      id: execution.run.id,
      error: {
        type: "INTERNAL_ERROR",
        code,
        message:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : typeof error === "string"
            ? error
            : undefined,
        stackTrace: error instanceof Error ? error.stack : undefined,
      },
    } satisfies TaskRunExecutionResult;
  }
}
