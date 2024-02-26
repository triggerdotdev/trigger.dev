import { FetchInstrumentation, HttpInstrumentation, TracingSDK } from "@trigger.dev/core/v3/otel";
// import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";

// IMPORTANT: this needs to be the first import to work properly
// WARNING: [WARNING] Constructing "ImportInTheMiddle" will crash at run-time because it's an import namespace object, not a constructor [call-import-namespace]
// TODO: https://github.com/open-telemetry/opentelemetry-js/issues/3954
const tracingSDK = new TracingSDK({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
  resource: new Resource({
    [SemanticInternalAttributes.CLI_VERSION]: packageJson.version,
  }),
  instrumentations: [
    new HttpInstrumentation({
      ignoreOutgoingRequestHook: (req) => {
        return process.env.TRIGGER_API_URL
          ? urlToRegex(process.env.TRIGGER_API_URL).test(req.host ?? "")
          : false;
      },
    }),
    new FetchInstrumentation({
      ignoreUrls: process.env.TRIGGER_API_URL ? [urlToRegex(process.env.TRIGGER_API_URL)] : [],
    }),
    // new OpenAIInstrumentation(),
  ],
});

function urlToRegex(url: string): RegExp {
  const urlObj = new URL(url);
  const hostnameToIgnore = urlObj.hostname.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  const regexToIgnore = new RegExp(hostnameToIgnore);

  return regexToIgnore;
}

const otelTracer = tracingSDK.getTracer("trigger-prod-worker", packageJson.version);
const otelLogger = tracingSDK.getLogger("trigger-prod-worker", packageJson.version);

import { SpanKind } from "@opentelemetry/api";
import {
  ConsoleInterceptor,
  CreateBackgroundWorkerResponse,
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
  calculateNextRetryTimestamp,
  childToWorkerMessages,
  logger,
  parseError,
  runtime,
  taskContextManager,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import * as packageJson from "../package.json";

import { Resource } from "@opentelemetry/resources";
import { flattenAttributes } from "@trigger.dev/core/v3";
import { TaskMetadataWithRun } from "./types.js";

const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
const consoleInterceptor = new ConsoleInterceptor(otelLogger);

const prodRuntimeManager = new ProdRuntimeManager();

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
  constructor(public task: TaskMetadataWithRun) {}

  async determineRetrying(
    execution: TaskRunExecution,
    error: unknown
  ): Promise<TaskRunExecutionRetry | undefined> {
    if (!this.task.retry) {
      return;
    }

    const retry = this.task.retry;

    const timestamp = calculateNextRetryTimestamp(retry, execution.attempt.number);

    return timestamp ? { timestamp } : undefined;
  }

  async execute(
    execution: TaskRunExecution,
    worker: CreateBackgroundWorkerResponse,
    traceContext: Record<string, unknown>
  ) {
    const parsedPayload = JSON.parse(execution.run.payload);
    const ctx = TaskRunContext.parse(execution);
    const attemptMessage = `Attempt #${execution.attempt.number}`;

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
              const output = await this.task.run({
                payload: parsedPayload,
                ctx: TaskRunContext.parse(execution),
              });

              span.setAttributes(flattenAttributes(output, SemanticInternalAttributes.OUTPUT));

              return output;
            });
          },
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "task",
            },
          },
          tracer.extractContext(traceContext)
        );
      }
    );

    return { output: JSON.stringify(output), outputType: "application/json" };
  }
}

function getTasks(): Array<TaskMetadataWithRun> {
  const result: Array<TaskMetadataWithRun> = [];

  for (const [importName, taskFile] of Object.entries(TaskFiles)) {
    const fileImports = TaskFileImports[importName];

    for (const [exportName, task] of Object.entries(fileImports ?? {})) {
      if ((task as any).__trigger) {
        result.push({
          id: (task as any).__trigger.id,
          exportName,
          packageVersion: (task as any).__trigger.packageVersion,
          filePath: (taskFile as any).filePath,
          run: (task as any).__trigger.run,
          retry: (task as any).__trigger.retry,
        });
      }
    }
  }

  return result;
}

function getTaskMetadata(): Array<TaskMetadataWithFilePath> {
  const result = getTasks();

  // Remove the run function from the metadata
  return result.map((task) => {
    const { run, ...metadata } = task;

    return metadata;
  });
}

const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

const tasks = getTasks();

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
      }
    },
    TASK_RUN_COMPLETED_NOTIFICATION: async ({ completion, execution }) => {
      prodRuntimeManager.resumeTask(completion, execution);
    },
    CLEANUP: async ({ flush, kill }) => {
      if (kill) {
        // Now we need to exit the process
        await sender.send("READY_TO_DISPOSE", undefined);
        await tracingSDK.shutdown();
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
