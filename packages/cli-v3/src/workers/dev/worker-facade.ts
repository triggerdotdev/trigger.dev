import {
  Config,
  LogLevel,
  ProjectConfig,
  clock,
  taskCatalog,
  type HandleErrorFunction,
} from "@trigger.dev/core/v3";
import {
  TaskExecutor,
  DurableClock,
  getEnvVar,
  logLevels,
  OtelTaskLogger,
  ConsoleInterceptor,
  type TracingSDK,
  usage,
  DevUsageManager,
} from "@trigger.dev/core/v3/workers";

__WORKER_SETUP__;
declare const __WORKER_SETUP__: unknown;

__IMPORTED_PROJECT_CONFIG__;
declare const __IMPORTED_PROJECT_CONFIG__: unknown;
declare const importedConfig: ProjectConfig | undefined;
declare const handleError: HandleErrorFunction | undefined;

declare const __PROJECT_CONFIG__: Config;
declare const tracingSDK: TracingSDK;
declare const otelTracer: Tracer;
declare const otelLogger: Logger;

import {
  TaskRunErrorCodes,
  TaskRunExecution,
  TriggerTracer,
  childToWorkerMessages,
  logger,
  runtime,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import { DevRuntimeManager } from "@trigger.dev/core/v3/dev";
import {
  ZodMessageHandler,
  ZodMessageSender,
  ZodSchemaParsedError,
} from "@trigger.dev/core/v3/zodMessageHandler";
import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";

declare const sender: ZodMessageSender<typeof childToWorkerMessages>;

const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);

usage.setGlobalUsageManager(new DevUsageManager());

const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
const consoleInterceptor = new ConsoleInterceptor(
  otelLogger,
  typeof __PROJECT_CONFIG__.enableConsoleLogging === "boolean"
    ? __PROJECT_CONFIG__.enableConsoleLogging
    : true
);

const devRuntimeManager = new DevRuntimeManager();

runtime.setGlobalRuntimeManager(devRuntimeManager);

const triggerLogLevel = getEnvVar("TRIGGER_LOG_LEVEL");

const configLogLevel = triggerLogLevel
  ? triggerLogLevel
  : importedConfig
  ? importedConfig.logLevel
  : __PROJECT_CONFIG__.logLevel;

const otelTaskLogger = new OtelTaskLogger({
  logger: otelLogger,
  tracer: tracer,
  level: logLevels.includes(configLogLevel as any) ? (configLogLevel as LogLevel) : "info",
});

logger.setGlobalTaskLogger(otelTaskLogger);

type TaskFileImport = Record<string, unknown>;

const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<string, string> = {};

__TASKS__;
declare const __TASKS__: Record<string, string>;

// Register the task file metadata (fileName and exportName) for each task
(() => {
  for (const [importName, taskFile] of Object.entries(TaskFiles)) {
    const fileImports = TaskFileImports[importName];

    for (const [exportName, task] of Object.entries(fileImports ?? {})) {
      if (
        typeof task === "object" &&
        task !== null &&
        "id" in task &&
        typeof task.id === "string"
      ) {
        if (taskCatalog.taskExists(task.id)) {
          taskCatalog.registerTaskFileMetadata(task.id, {
            exportName,
            filePath: (taskFile as any).filePath,
          });
        }
      }
    }
  }
})();

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
            id: execution.run.id,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.TASK_ALREADY_RUNNING,
            },
            usage: {
              durationMs: 0,
            },
          },
        });

        return;
      }

      process.title = `trigger-dev-worker: ${execution.task.id} ${execution.run.id}`;

      const task = taskCatalog.getTask(execution.task.id);

      if (!task) {
        console.error(`Could not find task ${execution.task.id}`);

        await sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            ok: false,
            id: execution.run.id,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.COULD_NOT_FIND_EXECUTOR,
            },
            usage: {
              durationMs: 0,
            },
          },
        });

        return;
      }

      const executor = new TaskExecutor(task, {
        tracer,
        tracingSDK,
        consoleInterceptor,
        projectConfig: __PROJECT_CONFIG__,
        importedConfig,
        handleErrorFn: handleError,
      });

      try {
        _execution = execution;
        _isRunning = true;

        const measurement = usage.start();

        const { result } = await executor.execute(execution, metadata, traceContext, measurement);

        const usageSample = usage.stop(measurement);

        return sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            ...result,
            usage: {
              durationMs: usageSample.cpuTime,
            },
          },
        });
      } finally {
        _execution = undefined;
        _isRunning = false;
      }
    },
    TASK_RUN_COMPLETED_NOTIFICATION: async (payload) => {
      switch (payload.version) {
        case "v1": {
          devRuntimeManager.resumeTask(payload.completion, payload.execution.run.id);
          break;
        }
        case "v2": {
          devRuntimeManager.resumeTask(payload.completion, payload.completion.id);
          break;
        }
      }
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

const TASK_METADATA = taskCatalog.getAllTaskMetadata();

sender.send("TASKS_READY", { tasks: TASK_METADATA }).catch((err) => {
  if (err instanceof ZodSchemaParsedError) {
    sender.send("TASKS_FAILED_TO_PARSE", { zodIssues: err.error.issues, tasks: TASK_METADATA });
  } else {
    console.error("Failed to send TASKS_READY message", err);
  }
});

process.title = "trigger-dev-worker";

async function asyncHeartbeat(initialDelayInSeconds: number = 30, intervalInSeconds: number = 30) {
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

// Start the async interval after 30 seconds
asyncHeartbeat().catch((err) => {
  console.error("Failed to start asyncHeartbeat", err);
});
