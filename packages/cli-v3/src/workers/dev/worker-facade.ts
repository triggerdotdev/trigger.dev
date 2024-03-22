import {
  Config,
  ProjectConfig,
  TaskExecutor,
  preciseDateOriginNow,
  type TracingSDK,
  type HandleErrorFunction,
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

const otelTracer = tracingSDK.getTracer("trigger-dev-worker", packageJson.version);
const otelLogger = tracingSDK.getLogger("trigger-dev-worker", packageJson.version);

import {
  ConsoleInterceptor,
  DevRuntimeManager,
  OtelTaskLogger,
  TaskMetadataWithFilePath,
  TaskRunErrorCodes,
  TaskRunExecution,
  TriggerTracer,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  logger,
  runtime,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import * as packageJson from "../../../package.json";

import { TaskMetadataWithFunctions } from "../../types.js";

declare const sender: ZodMessageSender<typeof childToWorkerMessages>;

const preciseDateOrigin = preciseDateOriginNow();

const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
const consoleInterceptor = new ConsoleInterceptor(otelLogger, preciseDateOrigin);

const devRuntimeManager = new DevRuntimeManager();

runtime.setGlobalRuntimeManager(devRuntimeManager);

const otelTaskLogger = new OtelTaskLogger({
  logger: otelLogger,
  tracer: tracer,
  level: "info",
  preciseDateOrigin,
});

logger.setGlobalTaskLogger(otelTaskLogger);

type TaskFileImport = Record<string, unknown>;

const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<string, string> = {};

__TASKS__;
declare const __TASKS__: Record<string, string>;

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
  taskExecutors.set(
    task.id,
    new TaskExecutor(task, {
      tracer,
      tracingSDK,
      consoleInterceptor,
      projectConfig: __PROJECT_CONFIG__,
      importedConfig,
      handleErrorFn: handleError,
    })
  );
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

      process.title = `trigger-dev-worker: ${execution.task.id} ${execution.run.id}`;

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
          result,
        });
      } finally {
        _execution = undefined;
        _isRunning = false;
      }
    },
    TASK_RUN_COMPLETED_NOTIFICATION: async ({ completion, execution }) => {
      devRuntimeManager.resumeTask(completion, execution);
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

process.title = "trigger-dev-worker";

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

// Start the async interval after 30 seconds
asyncHeartbeat().catch((err) => {
  console.error("Failed to start asyncHeartbeat", err);
});
