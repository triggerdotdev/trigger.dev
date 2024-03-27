import { SpanKind } from "@opentelemetry/api";
import { ConsoleInterceptor } from "../consoleInterceptor";
import { parseError } from "../errors";
import { TracingSDK, recordSpanException } from "../otel";
import {
  BackgroundWorkerProperties,
  Config,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunExecutionRetry,
} from "../schemas";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { taskContextManager } from "../tasks/taskContextManager";
import { TriggerTracer } from "../tracer";
import { HandleErrorFunction, ProjectConfig, TaskMetadataWithFunctions } from "../types";
import {
  conditionallyExportPacket,
  conditionallyImportPacket,
  createPacketAttributes,
  parsePacket,
  stringifyIO,
} from "../utils/ioSerialization";
import { calculateNextRetryDelay } from "../utils/retries";
import { accessoryAttributes } from "../utils/styleAttributes";

export type TaskExecutorOptions = {
  tracingSDK: TracingSDK;
  tracer: TriggerTracer;
  consoleInterceptor: ConsoleInterceptor;
  projectConfig: Config;
  importedConfig: ProjectConfig | undefined;
  handleErrorFn: HandleErrorFunction | undefined;
};

export class TaskExecutor {
  private _tracingSDK: TracingSDK;
  private _tracer: TriggerTracer;
  private _consoleInterceptor: ConsoleInterceptor;
  private _config: Config;
  private _importedConfig: ProjectConfig | undefined;
  private _handleErrorFn: HandleErrorFunction | undefined;

  constructor(
    public task: TaskMetadataWithFunctions,
    options: TaskExecutorOptions
  ) {
    this._tracingSDK = options.tracingSDK;
    this._tracer = options.tracer;
    this._consoleInterceptor = options.consoleInterceptor;
    this._config = options.projectConfig;
    this._importedConfig = options.importedConfig;
    this._handleErrorFn = options.handleErrorFn;
  }

  async execute(
    execution: TaskRunExecution,
    worker: BackgroundWorkerProperties,
    traceContext: Record<string, unknown>
  ): Promise<TaskRunExecutionResult> {
    const ctx = TaskRunContext.parse(execution);
    const attemptMessage = `Attempt ${execution.attempt.number}`;

    const originalPacket = {
      data: execution.run.payload,
      dataType: execution.run.payloadType,
    };

    const result = await taskContextManager.runWith(
      {
        ctx,
        worker,
      },
      async () => {
        this._tracingSDK.asyncResourceDetector.resolveWithAttributes({
          ...taskContextManager.attributes,
          [SemanticInternalAttributes.SDK_VERSION]: this.task.packageVersion,
          [SemanticInternalAttributes.SDK_LANGUAGE]: "typescript",
        });

        return await this._tracer.startActiveSpan(
          attemptMessage,
          async (span) => {
            return await this._consoleInterceptor.intercept(console, async () => {
              let parsedPayload: any;
              let initOutput: any;

              try {
                const payloadPacket = await conditionallyImportPacket(originalPacket, this._tracer);

                parsedPayload = parsePacket(payloadPacket);

                initOutput = await this.#callTaskInit(parsedPayload, ctx);

                const output = await this.#callRun(parsedPayload, ctx, initOutput);

                try {
                  const stringifiedOutput = stringifyIO(output);

                  const finalOutput = await conditionallyExportPacket(
                    stringifiedOutput,
                    `${execution.attempt.id}/output`,
                    this._tracer
                  );

                  span.setAttributes(
                    createPacketAttributes(
                      finalOutput,
                      SemanticInternalAttributes.OUTPUT,
                      SemanticInternalAttributes.OUTPUT_TYPE
                    )
                  );

                  return {
                    ok: true,
                    id: execution.attempt.id,
                    output: finalOutput.data,
                    outputType: finalOutput.dataType,
                  } satisfies TaskRunExecutionResult;
                } catch (stringifyError) {
                  recordSpanException(span, stringifyError);

                  return {
                    ok: false,
                    id: execution.attempt.id,
                    error: {
                      type: "INTERNAL_ERROR",
                      code: TaskRunErrorCodes.TASK_OUTPUT_ERROR,
                      message:
                        stringifyError instanceof Error
                          ? stringifyError.message
                          : typeof stringifyError === "string"
                          ? stringifyError
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
                    ctx
                  );

                  recordSpanException(span, handleErrorResult.error ?? runError);

                  return {
                    id: execution.attempt.id,
                    ok: false,
                    error: handleErrorResult.error
                      ? parseError(handleErrorResult.error)
                      : parseError(runError),
                    retry:
                      handleErrorResult.status === "retry" ? handleErrorResult.retry : undefined,
                    skippedRetrying: handleErrorResult.status === "skipped",
                  } satisfies TaskRunExecutionResult;
                } catch (handleErrorError) {
                  recordSpanException(span, handleErrorError);

                  return {
                    ok: false,
                    id: execution.attempt.id,
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
                await this.#callTaskCleanup(parsedPayload, ctx, initOutput);
              }
            });
          },
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "attempt",
              ...accessoryAttributes({
                items: [
                  {
                    text: ctx.task.filePath,
                  },
                  {
                    text: `${ctx.task.exportName}.run()`,
                  },
                ],
                style: "codepath",
              }),
            },
          },
          this._tracer.extractContext(traceContext)
        );
      }
    );

    return result;
  }

  async #callRun(payload: unknown, ctx: TaskRunContext, init: unknown) {
    const runFn = this.task.fns.run;
    const middlewareFn = this.task.fns.middleware;

    if (!runFn) {
      throw new Error("Task does not have a run function");
    }

    if (!middlewareFn) {
      return runFn(payload, { ctx });
    }

    return middlewareFn(payload, { ctx, next: async () => runFn(payload, { ctx, init }) });
  }

  async #callTaskInit(payload: unknown, ctx: TaskRunContext) {
    const initFn = this.task.fns.init;

    if (!initFn) {
      return {};
    }

    return this._tracer.startActiveSpan("init", async (span) => {
      return await initFn(payload, { ctx });
    });
  }

  async #callTaskCleanup(payload: unknown, ctx: TaskRunContext, init: unknown) {
    const cleanupFn = this.task.fns.cleanup;

    if (!cleanupFn) {
      return;
    }

    return this._tracer.startActiveSpan("cleanup", async (span) => {
      return await cleanupFn(payload, { ctx, init });
    });
  }

  async #handleError(
    execution: TaskRunExecution,
    error: unknown,
    payload: any,
    ctx: TaskRunContext
  ): Promise<
    | { status: "retry"; retry: TaskRunExecutionRetry; error?: unknown }
    | { status: "skipped"; error?: unknown } // skipped is different than noop, it means that the task was skipped from retrying, instead of just not retrying
    | { status: "noop"; error?: unknown }
  > {
    const retriesConfig = this._importedConfig?.retries ?? this._config.retries;

    const retry = this.task.retry ?? retriesConfig?.default;

    if (!retry) {
      return { status: "noop" };
    }

    const delay = calculateNextRetryDelay(retry, execution.attempt.number);

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
            })
          : this._importedConfig
          ? await this._handleErrorFn?.(payload, error, {
              ctx,
              retry,
              retryDelayInMs: delay,
              retryAt: delay ? new Date(Date.now() + delay) : undefined,
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
