import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  clock,
  type HandleErrorFunction,
  logger,
  LogLevel,
  runtime,
  taskCatalog,
  TaskRunErrorCodes,
  TaskRunExecution,
  WorkerToExecutorMessageCatalog,
  TriggerConfig,
  TriggerTracer,
  WorkerManifest,
  ExecutorToWorkerMessageCatalog,
} from "@trigger.dev/core/v3";
import { ProdRuntimeManager } from "@trigger.dev/core/v3/prod";
import {
  ConsoleInterceptor,
  DevUsageManager,
  DurableClock,
  getEnvVar,
  logLevels,
  OtelTaskLogger,
  ProdUsageManager,
  StandardTaskCatalog,
  TaskExecutor,
  TracingDiagnosticLogLevel,
  TracingSDK,
  usage,
} from "@trigger.dev/core/v3/workers";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { readFile } from "node:fs/promises";
import sourceMapSupport from "source-map-support";
import { VERSION } from "../version.js";
import { setTimeout, setInterval } from "node:timers/promises";
import { env } from "std-env";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

process.on("uncaughtException", function (error, origin) {
  if (error instanceof Error) {
    process.send &&
      process.send({
        type: "EVENT",
        message: {
          type: "UNCAUGHT_EXCEPTION",
          payload: {
            error: { name: error.name, message: error.message, stack: error.stack },
            origin,
          },
          version: "v1",
        },
      });
  } else {
    process.send &&
      process.send({
        type: "EVENT",
        message: {
          type: "UNCAUGHT_EXCEPTION",
          payload: {
            error: {
              name: "Error",
              message: typeof error === "string" ? error : JSON.stringify(error),
            },
            origin,
          },
          version: "v1",
        },
      });
  }
});

const heartbeatIntervalMs = getEnvVar("USAGE_HEARTBEAT_INTERVAL_MS");
const usageEventUrl = getEnvVar("USAGE_EVENT_URL");
const triggerJWT = getEnvVar("TRIGGER_JWT");

const prodUsageManager = new ProdUsageManager(new DevUsageManager(), {
  heartbeatIntervalMs: heartbeatIntervalMs ? parseInt(heartbeatIntervalMs, 10) : undefined,
  url: usageEventUrl,
  jwt: triggerJWT,
});

usage.setGlobalUsageManager(prodUsageManager);

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);

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

async function loadWorkerManifest() {
  const manifestContents = await readFile("./index.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return WorkerManifest.parse(raw);
}

async function bootstrap() {
  const workerManifest = await loadWorkerManifest();

  const { config, handleError } = await importConfig(workerManifest.configPath);

  const tracingSDK = new TracingSDK({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
    instrumentations: config.instrumentations ?? [],
    diagLogLevel: (env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
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

  for (const task of workerManifest.tasks) {
    taskCatalog.registerTaskFileMetadata(task.id, {
      exportName: task.exportName,
      filePath: task.filePath,
      entryPoint: task.entryPoint,
    });
  }

  return {
    tracer,
    tracingSDK,
    consoleInterceptor,
    config,
    handleErrorFn: handleError,
    workerManifest,
  };
}

let _execution: TaskRunExecution | undefined;
let _isRunning = false;
let _tracingSDK: TracingSDK | undefined;

const zodIpc = new ZodIpcConnection({
  listenSchema: WorkerToExecutorMessageCatalog,
  emitSchema: ExecutorToWorkerMessageCatalog,
  process,
  handlers: {
    EXECUTE_TASK_RUN: async ({ execution, traceContext, metadata }, sender) => {
      console.log(`[${new Date().toISOString()}] Received EXECUTE_TASK_RUN`, execution);

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

      try {
        const { tracer, tracingSDK, consoleInterceptor, config, handleErrorFn, workerManifest } =
          await bootstrap();

        _tracingSDK = tracingSDK;

        const taskManifest = workerManifest.tasks.find((t) => t.id === execution.task.id);

        if (!taskManifest) {
          console.error(`Could not find task ${execution.task.id}`);

          await sender.send("TASK_RUN_COMPLETED", {
            execution,
            result: {
              ok: false,
              id: execution.run.id,
              error: {
                type: "INTERNAL_ERROR",
                code: TaskRunErrorCodes.COULD_NOT_FIND_TASK,
              },
              usage: {
                durationMs: 0,
              },
            },
          });

          return;
        }

        try {
          const beforeImport = performance.now();
          await import(taskManifest.entryPoint);
          const durationMs = performance.now() - beforeImport;

          console.log(
            `Imported task ${execution.task.id} [${taskManifest.entryPoint}] in ${durationMs}ms`
          );
        } catch (err) {
          console.error(`Failed to import task ${execution.task.id}`, err);

          await sender.send("TASK_RUN_COMPLETED", {
            execution,
            result: {
              ok: false,
              id: execution.run.id,
              error: {
                type: "INTERNAL_ERROR",
                code: TaskRunErrorCodes.COULD_NOT_IMPORT_TASK,
              },
              usage: {
                durationMs: 0,
              },
            },
          });

          return;
        }

        process.title = `trigger-dev-worker: ${execution.task.id} ${execution.run.id}`;

        // Import the task module
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
      } catch (err) {
        console.error("Failed to execute task", err);

        await sender.send("TASK_RUN_COMPLETED", {
          execution,
          result: {
            ok: false,
            id: execution.run.id,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.CONFIGURED_INCORRECTLY,
            },
            usage: {
              durationMs: 0,
            },
          },
        });
      }
    },
    TASK_RUN_COMPLETED_NOTIFICATION: async (payload) => {
      prodRuntimeManager.resumeTask(payload.completion);
    },
    WAIT_COMPLETED_NOTIFICATION: async () => {
      prodRuntimeManager.resumeAfterDuration();
    },
    FLUSH: async ({ timeoutInMs }, sender) => {
      await flushAll(timeoutInMs);
    },
  },
});

async function flushAll(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.all([flushUsage(timeoutInMs), flushTracingSDK(timeoutInMs)]);

  const duration = performance.now() - now;

  console.log(`Flushed all in ${duration}ms`);
}

async function flushUsage(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([prodUsageManager.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  console.log(`Flushed usage in ${duration}ms`);
}

async function flushTracingSDK(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([_tracingSDK?.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  console.log(`Flushed tracingSDK in ${duration}ms`);
}

const prodRuntimeManager = new ProdRuntimeManager(zodIpc, {
  waitThresholdInMs: parseInt(env.TRIGGER_RUNTIME_WAIT_THRESHOLD_IN_MS ?? "30000", 10),
});

runtime.setGlobalRuntimeManager(prodRuntimeManager);

process.title = "trigger-dev-worker";

for await (const _ of setInterval(15_000)) {
  if (_isRunning && _execution) {
    try {
      await zodIpc.send("TASK_HEARTBEAT", { id: _execution.attempt.id });
    } catch (err) {
      console.error("Failed to send HEARTBEAT message", err);
    }
  }
}

console.log(`[${new Date().toISOString()}] Executor started`);
