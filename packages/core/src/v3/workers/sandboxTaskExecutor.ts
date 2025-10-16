import { context, SpanKind } from "@opentelemetry/api";
import { promiseWithResolvers } from "../../utils.js";
import { ConsoleInterceptor } from "../consoleInterceptor.js";
import { parseError, sanitizeError } from "../errors.js";
import { attemptKey, runMetadata, traceContext } from "../index.js";
import { recordSpanException, TracingSDK } from "../otel/index.js";
import { runTimelineMetrics } from "../run-timeline-metrics-api.js";
import {
  COLD_VARIANT,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "../schemas/index.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { TriggerTracer } from "../tracer.js";
import { tryCatch } from "../tryCatch.js";
import {
  conditionallyExportPacket,
  conditionallyImportPacket,
  createPacketAttributes,
  parsePacket,
  stringifyIO,
} from "../utils/ioSerialization.js";

export type SandboxTaskExecutorOptions = {
  tracingSDK: TracingSDK;
  tracer: TriggerTracer;
  consoleInterceptor: ConsoleInterceptor;
};

export class SandboxTaskExecutor {
  private _tracingSDK: TracingSDK;
  private _tracer: TriggerTracer;
  private _consoleInterceptor: ConsoleInterceptor;

  constructor(private readonly options: SandboxTaskExecutorOptions) {
    this._tracingSDK = options.tracingSDK;
    this._tracer = options.tracer;
    this._consoleInterceptor = options.consoleInterceptor;
  }

  async execute(
    execution: TaskRunExecution,
    signal: AbortSignal
  ): Promise<{ result: TaskRunExecutionResult }> {
    const attemptMessage = `Attempt ${execution.attempt.number}`;

    const originalPacket = {
      data: execution.run.payload,
      dataType: execution.run.payloadType,
    };

    if (execution.run.metadata) {
      runMetadata.enterWithMetadata(execution.run.metadata);
    }

    const result = await this._tracer.startActiveSpan(
      attemptMessage,
      async (span) => {
        const attemptContext = context.active();

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

          const [parsePayloadError, parsedPayloadResult] = await tryCatch(
            this.#parsePayload(payloadResult)
          );

          if (parsePayloadError) {
            recordSpanException(span, parsePayloadError);
            return this.#internalErrorResult(
              execution,
              TaskRunErrorCodes.TASK_INPUT_ERROR,
              parsePayloadError,
              true
            );
          }

          parsedPayload = parsedPayloadResult;

          const {
            promise: runPromise,
            resolve: runResolve,
            reject: runReject,
          } = promiseWithResolvers<void>();

          // Make sure the run promise does not cause unhandled promise rejections
          runPromise.catch(() => {});

          const executeTask = async (payload: any) => {
            const [runError, output] = await tryCatch(
              (async () => {
                return {};
              })()
            );

            if (runError) {
              runReject(runError);

              return {
                id: execution.run.id,
                ok: false,
                error: sanitizeError(parseError(runError)),
              } satisfies TaskRunExecutionResult;
            }

            runResolve(output as any);

            const [outputError, stringifiedOutput] = await tryCatch(stringifyIO(output));

            if (outputError) {
              recordSpanException(span, outputError);

              return this.#internalErrorResult(
                execution,
                TaskRunErrorCodes.TASK_OUTPUT_ERROR,
                outputError
              );
            }

            const [exportError, finalOutput] = await tryCatch(
              conditionallyExportPacket(
                stringifiedOutput,
                `${attemptKey(execution)}/output`,
                this._tracer
              )
            );

            if (exportError) {
              recordSpanException(span, exportError);

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

            return {
              ok: true,
              id: execution.run.id,
              output: finalOutput.data,
              outputType: finalOutput.dataType,
            } satisfies TaskRunExecutionResult;
          };

          return await executeTask(parsedPayload);
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "attempt",
          [SemanticInternalAttributes.ENTITY_TYPE]: "attempt",
          [SemanticInternalAttributes.SPAN_ATTEMPT]: true,
          ...(execution.attempt.number === 1
            ? runTimelineMetrics.convertMetricsToSpanAttributes()
            : {}),
          [SemanticInternalAttributes.STYLE_VARIANT]: COLD_VARIANT,
        },
        events:
          execution.attempt.number === 1
            ? runTimelineMetrics.convertMetricsToSpanEvents()
            : undefined,
      },
      traceContext.extractContext()
    );

    return { result };
  }

  async #parsePayload(payload: unknown) {
    return payload;
  }

  #internalErrorResult(
    execution: TaskRunExecution,
    code: TaskRunErrorCodes,
    error: unknown,
    skippedRetrying?: boolean
  ) {
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
      skippedRetrying,
    } satisfies TaskRunExecutionResult;
  }
}
