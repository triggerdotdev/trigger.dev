import {
  Config,
  DurableClock,
  HandleErrorFunction,
  LogLevel,
  ProdChildToWorkerMessages,
  ProdWorkerToChildMessages,
  ProjectConfig,
  TaskExecutor,
  ZodIpcConnection,
  ZodSchemaParsedError,
  clock,
  getEnvVar,
  logLevels,
  taskCatalog,
  type TracingSDK,
} from "@trigger.dev/core/v3";
import "source-map-support/register.js";

__WORKER_SETUP__;
declare const __WORKER_SETUP__: unknown;

__IMPORTED_PROJECT_CONFIG__;
declare const __IMPORTED_PROJECT_CONFIG__: unknown;
declare const importedConfig: ProjectConfig | undefined;
declare const handleError: HandleErrorFunction | undefined;

declare const __PROJECT_CONFIG__: Config;
declare const tracingSDK: TracingSDK;

const otelTracer = tracingSDK.getTracer("trigger-prod-worker", packageJson.version);
const otelLogger = tracingSDK.getLogger("trigger-prod-worker", packageJson.version);

import {
  ConsoleInterceptor,
  OtelTaskLogger,
  ProdRuntimeManager,
  TaskRunErrorCodes,
  TaskRunExecution,
  TriggerTracer,
  logger,
  runtime,
} from "@trigger.dev/core/v3";
import * as packageJson from "../../../package.json";

const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);

const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
const consoleInterceptor = new ConsoleInterceptor(otelLogger, false);

const triggerLogLevel = getEnvVar("TRIGGER_LOG_LEVEL");

const configLogLevel = triggerLogLevel
  ? triggerLogLevel
  : importedConfig
  ? importedConfig.logLevel
  : __PROJECT_CONFIG__.logLevel;

const otelTaskLogger = new OtelTaskLogger({
  logger: otelLogger,
  tracer: tracer,
  level: logLevels.includes(configLogLevel as any) ? (configLogLevel as LogLevel) : "log",
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
        taskCatalog.registerTaskFileMetadata(task.id, {
          exportName,
          filePath: (taskFile as any).filePath,
        });
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

        const result = await executor.execute(execution, metadata, traceContext);

        return sender.send("TASK_RUN_COMPLETED", {
          execution,
          result,
        });
      } finally {
        _execution = undefined;
        _isRunning = false;
      }
    },
    TASK_RUN_COMPLETED_NOTIFICATION: async ({ completion, execution }) => {
      prodRuntimeManager.resumeTask(completion, execution);
    },
    WAIT_COMPLETED_NOTIFICATION: async () => {
      prodRuntimeManager.resumeAfterRestore();
    },
    CLEANUP: async ({ flush, kill }, sender) => {
      if (kill) {
        await tracingSDK.flush();

        if (_execution) {
          // Fail currently executing attempt
          await sender.send("TASK_RUN_COMPLETED", {
            execution: _execution,
            result: {
              ok: false,
              id: _execution.run.id,
              error: {
                type: "INTERNAL_ERROR",
                code: TaskRunErrorCodes.GRACEFUL_EXIT_TIMEOUT,
                message: "Worker process killed while attempt in progress.",
              },
            },
          });
        }

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

// Ignore SIGTERM, handled by entry point
process.on("SIGTERM", async () => {});

const prodRuntimeManager = new ProdRuntimeManager(zodIpc, {
  waitThresholdInMs: parseInt(process.env.TRIGGER_RUNTIME_WAIT_THRESHOLD_IN_MS ?? "30000", 10),
});

runtime.setGlobalRuntimeManager(prodRuntimeManager);

const TASK_METADATA = taskCatalog.getAllTaskMetadata();

zodIpc.send("TASKS_READY", { tasks: TASK_METADATA }).catch((err) => {
  if (err instanceof ZodSchemaParsedError) {
    zodIpc.send("TASKS_FAILED_TO_PARSE", { zodIssues: err.error.issues, tasks: TASK_METADATA });
  } else {
    console.error("Failed to send TASKS_READY message", err);
  }
});

process.title = "trigger-prod-worker";

async function asyncHeartbeat(initialDelayInSeconds: number = 30, intervalInSeconds: number = 5) {
  async function _doHeartbeat() {
    while (true) {
      if (_isRunning && _execution) {
        try {
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
