import { SpanKind } from "@opentelemetry/api";
import { VERSION } from "../../version.js";
import { ApiError, RateLimitError } from "../apiClient/errors.js";
import { ConsoleInterceptor } from "../consoleInterceptor.js";
import { parseError, sanitizeError, TaskPayloadParsedError } from "../errors.js";
import { runMetadata, TriggerConfig } from "../index.js";
import { recordSpanException, TracingSDK } from "../otel/index.js";
import {
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
import { HandleErrorFunction, TaskMetadataWithFunctions } from "../types/index.js";
import { UsageMeasurement } from "../usage/types.js";
import {
  conditionallyExportPacket,
  conditionallyImportPacket,
  createPacketAttributes,
  parsePacket,
  stringifyIO,
} from "../utils/ioSerialization.js";
import { calculateNextRetryDelay } from "../utils/retries.js";

export type TaskExecutorOptions = {
  tracingSDK: TracingSDK;
  tracer: TriggerTracer;
  consoleInterceptor: ConsoleInterceptor;
  config: TriggerConfig | undefined;
  handleErrorFn: HandleErrorFunction | undefined;
};

export class TaskExecutor {
  private _tracingSDK: TracingSDK;
  private _tracer: TriggerTracer;
  private _consoleInterceptor: ConsoleInterceptor;
  private _importedConfig: TriggerConfig | undefined;
  private _handleErrorFn: HandleErrorFunction | undefined;

  constructor(
    public task: TaskMetadataWithFunctions,
    options: TaskExecutorOptions
  ) {
    this._tracingSDK = options.tracingSDK;
    this._tracer = options.tracer;
    this._consoleInterceptor = options.consoleInterceptor;
    this._importedConfig = options.config;
    this._handleErrorFn = options.handleErrorFn;
  }

  async execute(
    execution: TaskRunExecution,
    worker: ServerBackgroundWorker,
    traceContext: Record<string, unknown>,
    usage: UsageMeasurement,
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

          try {
            const payloadPacket = await conditionallyImportPacket(originalPacket, this._tracer);
            parsedPayload = await parsePacket(payloadPacket);
          } catch (inputError) {
            recordSpanException(span, inputError);

            return {
              ok: false,
              id: execution.run.id,
              error: {
                type: "INTERNAL_ERROR",
                code: TaskRunErrorCodes.TASK_INPUT_ERROR,
                message:
                  inputError instanceof Error
                    ? `${inputError.name}: ${inputError.message}`
                    : typeof inputError === "string"
                    ? inputError
                    : undefined,
                stackTrace: inputError instanceof Error ? inputError.stack : undefined,
              },
            } satisfies TaskRunExecutionResult;
          }

          try {
            parsedPayload = await this.#parsePayload(parsedPayload);

            if (execution.attempt.number === 1) {
              await this.#callOnStartFunctions(parsedPayload, ctx, signal);
            }

            initOutput = await this.#callInitFunctions(parsedPayload, ctx, signal);

            const output = await this.#callRun(parsedPayload, ctx, initOutput, signal);

            await this.#callOnSuccessFunctions(parsedPayload, output, ctx, initOutput, signal);

            try {
              const stringifiedOutput = await stringifyIO(output);

              const finalOutput = await conditionallyExportPacket(
                stringifiedOutput,
                `${execution.attempt.id}/output`,
                this._tracer
              );

              const attributes = await createPacketAttributes(
                finalOutput,
                SemanticInternalAttributes.OUTPUT,
                SemanticInternalAttributes.OUTPUT_TYPE
              );

              if (attributes) {
                span.setAttributes(attributes);
              }

              return {
                ok: true,
                id: execution.run.id,
                output: finalOutput.data,
                outputType: finalOutput.dataType,
              } satisfies TaskRunExecutionResult;
            } catch (outputError) {
              recordSpanException(span, outputError);

              return {
                ok: false,
                id: execution.run.id,
                error: {
                  type: "INTERNAL_ERROR",
                  code: TaskRunErrorCodes.TASK_OUTPUT_ERROR,
                  message:
                    outputError instanceof Error
                      ? outputError.message
                      : typeof outputError === "string"
                      ? outputError
                      : undefined,
                },
              } satisfies TaskRunExecutionResult;
            }
          } catch (runError) {
            try {
              const handleErrorResult = await this.#handleError(
                execution,
                runError,
                parsedPayload,
                ctx,
                signal
              );

              recordSpanException(span, handleErrorResult.error ?? runError);

              if (handleErrorResult.status !== "retry") {
                await this.#callOnFailureFunctions(
                  parsedPayload,
                  handleErrorResult.error ?? runError,
                  ctx,
                  initOutput,
                  signal
                );
              }

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
            } catch (handleErrorError) {
              recordSpanException(span, handleErrorError);

              return {
                ok: false,
                id: execution.run.id,
                error: {
                  type: "INTERNAL_ERROR",
                  code: TaskRunErrorCodes.HANDLE_ERROR_ERROR,
                  message:
                    handleErrorError instanceof Error
                      ? handleErrorError.message
                      : typeof handleErrorError === "string"
                      ? handleErrorError
                      : undefined,
                },
              } satisfies TaskRunExecutionResult;
            }
          } finally {
            await this.#callTaskCleanup(parsedPayload, ctx, initOutput, signal);
          }
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "attempt",
        },
      },
      this._tracer.extractContext(traceContext),
      signal
    );

    return { result };
  }

  async #callRun(payload: unknown, ctx: TaskRunContext, init: unknown, signal?: AbortSignal) {
    const runFn = this.task.fns.run;
    const middlewareFn = this.task.fns.middleware;

    if (!runFn) {
      throw new Error("Task does not have a run function");
    }

    if (!middlewareFn) {
      return runFn(payload, { ctx, init, signal });
    }

    return middlewareFn(payload, {
      ctx,
      signal,
      next: async () => runFn(payload, { ctx, init, signal }),
    });
  }

  async #callInitFunctions(payload: unknown, ctx: TaskRunContext, signal?: AbortSignal) {
    await this.#callConfigInit(payload, ctx, signal);

    const initFn = this.task.fns.init;

    if (!initFn) {
      return {};
    }

    return this._tracer.startActiveSpan(
      "init",
      async (span) => {
        return await initFn(payload, { ctx, signal });
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "function",
        },
      }
    );
  }

  async #callConfigInit(payload: unknown, ctx: TaskRunContext, signal?: AbortSignal) {
    const initFn = this._importedConfig?.init;

    if (!initFn) {
      return {};
    }

    return this._tracer.startActiveSpan(
      "config.init",
      async (span) => {
        return await initFn(payload, { ctx, signal });
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "function",
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
    await this.#callOnSuccessFunction(
      this.task.fns.onSuccess,
      "task.onSuccess",
      payload,
      output,
      ctx,
      initOutput,
      signal
    );

    await this.#callOnSuccessFunction(
      this._importedConfig?.onSuccess,
      "config.onSuccess",
      payload,
      output,
      ctx,
      initOutput,
      signal
    );
  }

  async #callOnSuccessFunction(
    onSuccessFn: TaskMetadataWithFunctions["fns"]["onSuccess"],
    name: string,
    payload: unknown,
    output: any,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    if (!onSuccessFn) {
      return;
    }

    try {
      await this._tracer.startActiveSpan(
        name,
        async (span) => {
          return await onSuccessFn(payload, output, { ctx, init: initOutput, signal });
        },
        {
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "function",
          },
        }
      );
    } catch {
      // Ignore errors from onSuccess functions
    }
  }

  async #callOnFailureFunctions(
    payload: unknown,
    error: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    await this.#callOnFailureFunction(
      this.task.fns.onFailure,
      "task.onFailure",
      payload,
      error,
      ctx,
      initOutput,
      signal
    );

    await this.#callOnFailureFunction(
      this._importedConfig?.onFailure,
      "config.onFailure",
      payload,
      error,
      ctx,
      initOutput,
      signal
    );
  }

  async #callOnFailureFunction(
    onFailureFn: TaskMetadataWithFunctions["fns"]["onFailure"],
    name: string,
    payload: unknown,
    error: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    if (!onFailureFn) {
      return;
    }

    try {
      return await this._tracer.startActiveSpan(
        name,
        async (span) => {
          return await onFailureFn(payload, error, { ctx, init: initOutput, signal });
        },
        {
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "function",
          },
        }
      );
    } catch (e) {
      // Ignore errors from onFailure functions
    }
  }

  async #parsePayload(payload: unknown) {
    if (!this.task.fns.parsePayload) {
      return payload;
    }

    try {
      return await this.task.fns.parsePayload(payload);
    } catch (e) {
      throw new TaskPayloadParsedError(e);
    }
  }

  async #callOnStartFunctions(payload: unknown, ctx: TaskRunContext, signal?: AbortSignal) {
    await this.#callOnStartFunction(
      this._importedConfig?.onStart,
      "config.onStart",
      payload,
      ctx,
      {},
      signal
    );

    await this.#callOnStartFunction(
      this.task.fns.onStart,
      "task.onStart",
      payload,
      ctx,
      {},
      signal
    );
  }

  async #callOnStartFunction(
    onStartFn: TaskMetadataWithFunctions["fns"]["onStart"],
    name: string,
    payload: unknown,
    ctx: TaskRunContext,
    initOutput: any,
    signal?: AbortSignal
  ) {
    if (!onStartFn) {
      return;
    }

    try {
      await this._tracer.startActiveSpan(
        name,
        async (span) => {
          return await onStartFn(payload, { ctx, signal });
        },
        {
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "function",
          },
        }
      );
    } catch {
      // Ignore errors from onStart functions
    }
  }

  async #callTaskCleanup(
    payload: unknown,
    ctx: TaskRunContext,
    init: unknown,
    signal?: AbortSignal
  ) {
    const cleanupFn = this.task.fns.cleanup;

    if (!cleanupFn) {
      return;
    }

    return this._tracer.startActiveSpan("cleanup", async (span) => {
      return await cleanupFn(payload, { ctx, init, signal });
    });
  }

  async #handleError(
    execution: TaskRunExecution,
    error: unknown,
    payload: any,
    ctx: TaskRunContext,
    signal?: AbortSignal
  ): Promise<
    | { status: "retry"; retry: TaskRunExecutionRetry; error?: unknown }
    | { status: "skipped"; error?: unknown } // skipped is different than noop, it means that the task was skipped from retrying, instead of just not retrying
    | { status: "noop"; error?: unknown }
  > {
    const retriesConfig = this._importedConfig?.retries;

    const retry = this.task.retry ?? retriesConfig?.default;

    if (!retry) {
      return { status: "noop" };
    }

    if (
      error instanceof Error &&
      (error.name === "AbortTaskRunError" || error.name === "TaskPayloadParsedError")
    ) {
      return { status: "skipped" };
    }

    if (execution.run.maxAttempts) {
      retry.maxAttempts = Math.max(execution.run.maxAttempts, 1);
    }

    let delay = calculateNextRetryDelay(retry, execution.attempt.number);

    if (
      delay &&
      error instanceof Error &&
      error.name === "TriggerApiError" &&
      (error as ApiError).status === 429
    ) {
      const rateLimitError = error as RateLimitError;

      delay = rateLimitError.millisecondsUntilReset;
    }

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
        const handleErrorResult = this.task.fns.handleError
          ? await this.task.fns.handleError(payload, error, {
              ctx,
              retry,
              retryDelayInMs: delay,
              retryAt: delay ? new Date(Date.now() + delay) : undefined,
              signal,
            })
          : this._importedConfig
          ? await this._handleErrorFn?.(payload, error, {
              ctx,
              retry,
              retryDelayInMs: delay,
              retryAt: delay ? new Date(Date.now() + delay) : undefined,
              signal,
            })
          : undefined;

        // If handleErrorResult
        if (!handleErrorResult) {
          return typeof delay === "undefined"
            ? { status: "noop" }
            : { status: "retry", retry: { timestamp: Date.now() + delay, delay } };
        }

        if (handleErrorResult.skipRetrying) {
          return { status: "skipped", error: handleErrorResult.error };
        }

        if (typeof handleErrorResult.retryAt !== "undefined") {
          return {
            status: "retry",
            retry: {
              timestamp: handleErrorResult.retryAt.getTime(),
              delay: handleErrorResult.retryAt.getTime() - Date.now(),
            },
            error: handleErrorResult.error,
          };
        }

        if (typeof handleErrorResult.retryDelayInMs === "number") {
          return {
            status: "retry",
            retry: {
              timestamp: Date.now() + handleErrorResult.retryDelayInMs,
              delay: handleErrorResult.retryDelayInMs,
            },
            error: handleErrorResult.error,
          };
        }

        if (handleErrorResult.retry && typeof handleErrorResult.retry === "object") {
          const delay = calculateNextRetryDelay(handleErrorResult.retry, execution.attempt.number);

          return typeof delay === "undefined"
            ? { status: "noop", error: handleErrorResult.error }
            : {
                status: "retry",
                retry: { timestamp: Date.now() + delay, delay },
                error: handleErrorResult.error,
              };
        }

        return { status: "noop", error: handleErrorResult.error };
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "exclamation-circle",
        },
      }
    );
  }
}
