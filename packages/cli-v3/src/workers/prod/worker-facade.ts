import { type TracingSDK } from "@trigger.dev/core/v3";
import "source-map-support/register.js";

__REGISTER_TRACING__;
declare const __REGISTER_TRACING__: unknown;
declare const tracingSDK: TracingSDK;

const otelTracer = tracingSDK.getTracer("trigger-prod-worker", packageJson.version);
const otelLogger = tracingSDK.getLogger("trigger-prod-worker", packageJson.version);

import { SpanKind } from "@opentelemetry/api";
import {
  ConsoleInterceptor,
  OtelTaskLogger,
  ProdRuntimeManager,
  SemanticInternalAttributes,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionRetry,
  TriggerTracer,
  ZodMessageHandler,
  ZodMessageSender,
  accessoryAttributes,
  calculateNextRetryDelay,
  childToWorkerMessages,
  logger,
  parseError,
  runtime,
  taskContextManager,
  workerToChildMessages,
  type BackgroundWorkerProperties,
} from "@trigger.dev/core/v3";
import * as packageJson from "../../../package.json";

import { flattenAttributes } from "@trigger.dev/core/v3";
import { TaskMetadataWithFunctions } from "../../types";

const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
const consoleInterceptor = new ConsoleInterceptor(otelLogger);

const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

const prodRuntimeManager = new ProdRuntimeManager(sender);

runtime.setGlobalRuntimeManager(prodRuntimeManager);

const otelTaskLogger = new OtelTaskLogger({
  logger: otelLogger,
  tracer: tracer,
  level: "info",
});

logger.setGlobalTaskLogger(otelTaskLogger);

type TaskFileImport = Record<string, unknown>;

const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<string, string> = {};

__TASKS__;
declare const __TASKS__: Record<string, string>;

class TaskExecutor {
  constructor(public task: TaskMetadataWithFunctions) {}

  async determineRetrying(
    execution: TaskRunExecution,
    error: unknown
  ): Promise<TaskRunExecutionRetry | undefined> {
    if (!this.task.retry) {
      return;
    }

    const retry = this.task.retry;

    const delay = calculateNextRetryDelay(retry, execution.attempt.number);

    return typeof delay === "undefined" ? undefined : { timestamp: Date.now() + delay, delay };
  }

  async execute(
    execution: TaskRunExecution,
    worker: BackgroundWorkerProperties,
    traceContext: Record<string, unknown>
  ) {
    const parsedPayload = JSON.parse(execution.run.payload);
    const ctx = TaskRunContext.parse(execution);
    const attemptMessage = `Attempt ${execution.attempt.number}`;

    const output = await taskContextManager.runWith(
      {
        ctx,
        payload: parsedPayload,
        worker,
      },
      async () => {
        tracingSDK.asyncResourceDetector.resolveWithAttributes({
          ...taskContextManager.attributes,
          [SemanticInternalAttributes.SDK_VERSION]: this.task.packageVersion,
          [SemanticInternalAttributes.SDK_LANGUAGE]: "typescript",
        });

        return await tracer.startActiveSpan(
          attemptMessage,
          async (span) => {
            return await consoleInterceptor.intercept(console, async () => {
              const init = await this.#callTaskInit(parsedPayload, ctx);

              try {
                const output = await this.#callRun(parsedPayload, ctx, init);

                span.setAttributes(flattenAttributes(output, SemanticInternalAttributes.OUTPUT));

                return output;
              } finally {
                await this.#callTaskCleanup(parsedPayload, ctx, init);
              }
            });
          },
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "attempt",
              ...flattenAttributes(parsedPayload, SemanticInternalAttributes.PAYLOAD),
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
          tracer.extractContext(traceContext)
        );
      }
    );

    return { output: JSON.stringify(output), outputType: "application/json" };
  }

  async #callRun(payload: unknown, ctx: TaskRunContext, init: unknown) {
    const runFn = this.task.fns.run;
    const middlewareFn = this.task.fns.middleware;

    if (!runFn) {
      throw new Error("Task does not have a run function");
    }

    if (!middlewareFn) {
      return runFn({ payload, ctx });
    }

    return middlewareFn({ payload, ctx, next: async () => runFn({ payload, ctx, init }) });
  }

  async #callTaskInit(payload: unknown, ctx: TaskRunContext) {
    const initFn = this.task.fns.init;

    if (!initFn) {
      return {};
    }

    return tracer.startActiveSpan("init", async (span) => {
      return await initFn({ payload, ctx });
    });
  }

  async #callTaskCleanup(payload: unknown, ctx: TaskRunContext, init: unknown) {
    const cleanupFn = this.task.fns.cleanup;

    if (!cleanupFn) {
      return;
    }

    return tracer.startActiveSpan("cleanup", async (span) => {
      return await cleanupFn({ payload, ctx, init });
    });
  }
}

function getTasks(): Array<TaskMetadataWithFunctions> {
  const result: Array<TaskMetadataWithFunctions> = [];

  for (const [importName, taskFile] of Object.entries(TaskFiles)) {
    const fileImports = TaskFileImports[importName];

    for (const [exportName, task] of Object.entries(fileImports ?? {})) {
      if ((task as any).__trigger) {
        result.push({
          id: (task as any).__trigger.id,
          exportName,
          packageVersion: (task as any).__trigger.packageVersion,
          filePath: (taskFile as any).filePath,
          queue: (task as any).__trigger.queue,
          retry: (task as any).__trigger.retry,
          fns: (task as any).__trigger.fns,
        });
      }
    }
  }

  return result;
}

function getTaskMetadata(): Array<TaskMetadataWithFilePath> {
  const result = getTasks();

  // Remove the functions from the metadata
  return result.map((task) => {
    const { fns, ...metadata } = task;

    return metadata;
  });
}

const tasks = getTasks();

runtime.registerTasks(tasks);

const taskExecutors: Map<string, TaskExecutor> = new Map();

for (const task of tasks) {
  taskExecutors.set(task.id, new TaskExecutor(task));
}

let _execution: TaskRunExecution | undefined;
let _isRunning = false;

const handler = new ZodMessageHandler({
  schema: workerToChildMessages,
  messages: {
    EXECUTE_TASK_RUN: async ({ execution, traceContext, metadata }) => {
      if (_isRunning) {
        console.error("Worker is already running a task");

        await sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            ok: false,
            id: execution.attempt.id,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.TASK_ALREADY_RUNNING,
            },
          },
        });

        return;
      }
      process.title = `trigger-prod-worker: ${execution.task.id} ${execution.run.id}`;

      const executor = taskExecutors.get(execution.task.id);

      if (!executor) {
        console.error(`Could not find executor for task ${execution.task.id}`);

        await sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            ok: false,
            id: execution.attempt.id,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.COULD_NOT_FIND_EXECUTOR,
            },
          },
        });

        return;
      }

      try {
        _execution = execution;
        _isRunning = true;

        const result = await executor.execute(execution, metadata, traceContext);

        return sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            id: execution.attempt.id,
            ok: true,
            ...result,
          },
        });
      } catch (e) {
        return sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            id: execution.attempt.id,
            ok: false,
            error: parseError(e),
            retry: await executor.determineRetrying(execution, e),
          },
        });
      } finally {
        _execution = undefined;
        _isRunning = false;
      }
    },
    TASK_RUN_COMPLETED_NOTIFICATION: async ({ completion, execution }) => {
      prodRuntimeManager.resumeTask(completion, execution);
    },
    CLEANUP: async ({ flush, kill }) => {
      if (kill) {
        await tracingSDK.flush();
        // Now we need to exit the process
        await sender.send("READY_TO_DISPOSE", undefined);
      } else {
        if (flush) {
          await tracingSDK.flush();
        }
      }
    },
  },
});

process.on("message", async (msg: any) => {
  await handler.handleMessage(msg);
});

sender.send("TASKS_READY", { tasks: getTaskMetadata() }).catch((err) => {
  console.error("Failed to send TASKS_READY message", err);
});

process.title = "trigger-prod-worker";

async function asyncHeartbeat(initialDelayInSeconds: number = 30, intervalInSeconds: number = 5) {
  async function _doHeartbeat() {
    while (true) {
      if (_isRunning && _execution) {
        try {
          await sender.send("TASK_HEARTBEAT", { id: _execution.attempt.id });
        } catch (err) {
          console.error("Failed to send HEARTBEAT message", err);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * intervalInSeconds));
    }
  }

  // Wait for the initial delay
  await new Promise((resolve) => setTimeout(resolve, 1000 * initialDelayInSeconds));

  // Wait for 5 seconds before the next execution
  return _doHeartbeat();
}

// Start the async interval after initial delay
asyncHeartbeat(5).catch((err) => {
  console.error("Failed to start asyncHeartbeat", err);
});
