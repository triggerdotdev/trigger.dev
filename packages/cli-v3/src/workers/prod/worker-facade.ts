import {
  Config,
  HandleErrorFunction,
  LogLevel,
  ProdChildToWorkerMessages,
  ProdWorkerToChildMessages,
  ProjectConfig,
  clock,
  taskCatalog,
} from "@trigger.dev/core/v3";
import {
  ConsoleInterceptor,
  DevUsageManager,
  DurableClock,
  OtelTaskLogger,
  ProdUsageManager,
  TaskExecutor,
  getEnvVar,
  logLevels,
  usage,
  type TracingSDK,
} from "@trigger.dev/core/v3/workers";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { ZodSchemaParsedError } from "@trigger.dev/core/v3/zodMessageHandler";
import "source-map-support/register.js";

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

import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  TaskRunErrorCodes,
  TaskRunExecution,
  TriggerTracer,
  logger,
  runtime,
} from "@trigger.dev/core/v3";
import { ProdRuntimeManager } from "@trigger.dev/core/v3/prod";

const heartbeatIntervalMs = getEnvVar("USAGE_HEARTBEAT_INTERVAL_MS");
const usageEventUrl = getEnvVar("USAGE_EVENT_URL");
const triggerJWT = getEnvVar("TRIGGER_JWT");

const prodUsageManager = new ProdUsageManager(new DevUsageManager(), {
  heartbeatIntervalMs: heartbeatIntervalMs ? parseInt(heartbeatIntervalMs, 10) : undefined,
  url: usageEventUrl,
  jwt: triggerJWT,
});

usage.setGlobalUsageManager(prodUsageManager);

const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);

const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
const consoleInterceptor = new ConsoleInterceptor(otelLogger, true);

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

const zodIpc = new ZodIpcConnection({
  listenSchema: ProdWorkerToChildMessages,
  emitSchema: ProdChildToWorkerMessages,
  process,
  handlers: {
    EXECUTE_TASK_RUN: async ({ execution, traceContext, metadata }, sender) => {
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
          },
        });

        return;
      }
      process.title = `trigger-prod-worker: ${execution.task.id} ${execution.run.id}`;

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

        return await sender.send("TASK_RUN_COMPLETED", {
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
    TASK_RUN_COMPLETED_NOTIFICATION: async ({ completion }) => {
      prodRuntimeManager.resumeTask(completion);
    },
    WAIT_COMPLETED_NOTIFICATION: async () => {
      prodRuntimeManager.resumeAfterDuration();
    },
    CLEANUP: async ({ flush, kill }, sender) => {
      if (kill) {
        await flushAll();
        // Now we need to exit the process
        await sender.send("READY_TO_DISPOSE", undefined);
      } else {
        if (flush) {
          await flushAll();
        }
      }
    },
  },
});

async function flushAll(timeoutInMs: number = 10_000) {
  const now = performance.now();

  console.log(`Flushing at ${now}`);

  await Promise.all([flushUsage(), flushTracingSDK()]);

  const duration = performance.now() - now;

  console.log(`Flushed in ${duration}ms`);
}

async function flushUsage() {
  const now = performance.now();

  console.log(`Flushing usage at ${now}`);

  await prodUsageManager.flush();

  const duration = performance.now() - now;

  console.log(`Flushed usage in ${duration}ms`);
}

async function flushTracingSDK() {
  const now = performance.now();

  console.log(`Flushing tracingSDK at ${now}`);

  await tracingSDK.flush();

  const duration = performance.now() - now;

  console.log(`Flushed tracingSDK in ${duration}ms`);
}

// Ignore SIGTERM, handled by entry point
process.on("SIGTERM", async () => {});

const prodRuntimeManager = new ProdRuntimeManager(zodIpc, {
  waitThresholdInMs: parseInt(process.env.TRIGGER_RUNTIME_WAIT_THRESHOLD_IN_MS ?? "30000", 10),
});

runtime.setGlobalRuntimeManager(prodRuntimeManager);

let taskMetadata = taskCatalog.getAllTaskMetadata();

if (typeof importedConfig?.machine === "string") {
  // Set the machine preset on all tasks that don't have it
  taskMetadata = taskMetadata.map((task) => {
    if (typeof task.machine?.preset !== "string") {
      return {
        ...task,
        machine: {
          preset: importedConfig.machine,
        },
      };
    }

    return task;
  });
}

zodIpc.send("TASKS_READY", { tasks: taskMetadata }).catch((err) => {
  if (err instanceof ZodSchemaParsedError) {
    zodIpc.send("TASKS_FAILED_TO_PARSE", { zodIssues: err.error.issues, tasks: taskMetadata });
  } else {
    console.error("Failed to send TASKS_READY message", err);
  }
});

process.title = "trigger-prod-worker";

async function asyncHeartbeat(initialDelayInSeconds: number = 30, intervalInSeconds: number = 20) {
  async function _doHeartbeat() {
    while (true) {
      if (_isRunning && _execution) {
        try {
          // The attempt ID will only be used to heartbeat if the message (run) ID isn't set on the TaskRunProcess
          await zodIpc.send("TASK_HEARTBEAT", { id: _execution.attempt.id });
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
