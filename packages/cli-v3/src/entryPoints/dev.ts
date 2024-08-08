import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  childToWorkerMessages,
  clock,
  type HandleErrorFunction,
  logger,
  LogLevel,
  runtime,
  taskCatalog,
  TaskRunErrorCodes,
  TaskRunExecution,
  TriggerConfig,
  TriggerTracer,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import { DevRuntimeManager } from "@trigger.dev/core/v3/dev";
import {
  ConsoleInterceptor,
  DevUsageManager,
  DurableClock,
  getEnvVar,
  logLevels,
  OtelTaskLogger,
  StandardTaskCatalog,
  TaskExecutor,
  TracingDiagnosticLogLevel,
  TracingSDK,
  usage,
} from "@trigger.dev/core/v3/workers";
import {
  ZodMessageHandler,
  ZodMessageSender,
  ZodSchemaParsedError,
} from "@trigger.dev/core/v3/zodMessageHandler";
import sourceMapSupport from "source-map-support";
import { VERSION } from "../version.js";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);
usage.setGlobalUsageManager(new DevUsageManager());
const devRuntimeManager = new DevRuntimeManager();
runtime.setGlobalRuntimeManager(devRuntimeManager);

const triggerLogLevel = getEnvVar("TRIGGER_LOG_LEVEL");

async function importConfig(
  configPath: string
): Promise<{ config: TriggerConfig; handleError?: HandleErrorFunction }> {
  const configModule = await import(configPath);

  const config = configModule?.default ?? configModule?.config;

  return {
    config,
    handleError: configModule?.handleError,
  };
}

async function bootstrap(configPath: string) {
  const { config, handleError } = await importConfig(configPath);

  const tracingSDK = new TracingSDK({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
    instrumentations: config.instrumentations ?? [],
    diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
    forceFlushTimeoutMillis: 30_000,
  });

  const otelTracer: Tracer = tracingSDK.getTracer("trigger-dev-worker", VERSION);
  const otelLogger: Logger = tracingSDK.getLogger("trigger-dev-worker", VERSION);

  const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
  const consoleInterceptor = new ConsoleInterceptor(
    otelLogger,
    typeof config.enableConsoleLogging === "boolean" ? config.enableConsoleLogging : true
  );

  const configLogLevel = triggerLogLevel ?? config.logLevel ?? "info";

  const otelTaskLogger = new OtelTaskLogger({
    logger: otelLogger,
    tracer: tracer,
    level: logLevels.includes(configLogLevel as any) ? (configLogLevel as LogLevel) : "info",
  });

  logger.setGlobalTaskLogger(otelTaskLogger);

  return { tracer, tracingSDK, consoleInterceptor, config, handleErrorFn: handleError };
}

async function registerTaskFileMetadata(files: Array<{ entry: string; out: string }>) {
  for (const file of files) {
    console.log("Detecting exported tasks in file", file.out);

    const module = await import(file.out);

    for (const exportName of Object.keys(module)) {
      const task = module[exportName];

      if (!task) {
        continue;
      }

      if (task[Symbol.for("trigger.dev/task")]) {
        if (taskCatalog.taskExists(task.id)) {
          taskCatalog.registerTaskFileMetadata(task.id, {
            exportName,
            filePath: file.out,
            entryPoint: file.entry,
          });
        }
      }
    }
  }
}

let _execution: TaskRunExecution | undefined;
let _isRunning = false;
let _tracingSDK: TracingSDK | undefined;

const handler = new ZodMessageHandler({
  schema: workerToChildMessages,
  messages: {
    INDEX: async ({ build }) => {
      await bootstrap(build.configPath);
      await registerTaskFileMetadata(build.files);

      const tasks = taskCatalog.listTaskManifests();

      await sender.send("INDEX_COMPLETE", { manifest: { tasks } }).catch((err) => {
        if (err instanceof ZodSchemaParsedError) {
          sender.send("TASKS_FAILED_TO_PARSE", {
            zodIssues: err.error.issues,
            tasks,
          });
        } else {
          console.error("Failed to send TASKS_READY message", err);
        }
      });
    },
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

      const { tracer, tracingSDK, consoleInterceptor, config, handleErrorFn } = await bootstrap(
        "./trigger.config.js"
      );

      const executor = new TaskExecutor(task, {
        tracer,
        tracingSDK,
        consoleInterceptor,
        config,
        handleErrorFn,
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
        await _tracingSDK?.flush();
        // Now we need to exit the process
        await sender.send("READY_TO_DISPOSE", undefined);
      } else {
        if (flush) {
          await _tracingSDK?.flush();
        }
      }
    },
  },
});

process.on("message", async (msg: any) => {
  await handler.handleMessage(msg);
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
