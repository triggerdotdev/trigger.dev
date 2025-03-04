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
  WorkerManifest,
  ExecutorToWorkerMessageCatalog,
  timeout,
  runMetadata,
  waitUntil,
  apiClientManager,
  runTimelineMetrics,
} from "@trigger.dev/core/v3";
import { TriggerTracer } from "@trigger.dev/core/v3/tracer";
import { DevRuntimeManager } from "@trigger.dev/core/v3/dev";
import {
  ConsoleInterceptor,
  DevUsageManager,
  UsageTimeoutManager,
  DurableClock,
  getEnvVar,
  logLevels,
  OtelTaskLogger,
  StandardTaskCatalog,
  TaskExecutor,
  TracingDiagnosticLogLevel,
  TracingSDK,
  usage,
  getNumberEnvVar,
  StandardMetadataManager,
  StandardWaitUntilManager,
  StandardRunTimelineMetricsManager,
} from "@trigger.dev/core/v3/workers";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { readFile } from "node:fs/promises";
import sourceMapSupport from "source-map-support";
import { VERSION } from "../version.js";
import { env } from "std-env";
import { normalizeImportPath } from "../utilities/normalizeImportPath.js";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

process.on("uncaughtException", function (error, origin) {
  if (error instanceof Error) {
    process.send &&
      process.send({
        type: "UNCAUGHT_EXCEPTION",
        payload: {
          error: { name: error.name, message: error.message, stack: error.stack },
          origin,
        },
        version: "v1",
      });
  } else {
    process.send &&
      process.send({
        type: "UNCAUGHT_EXCEPTION",
        payload: {
          error: {
            name: "Error",
            message: typeof error === "string" ? error : JSON.stringify(error),
          },
          origin,
        },
        version: "v1",
      });
  }
});

const standardRunTimelineMetricsManager = new StandardRunTimelineMetricsManager();
runTimelineMetrics.setGlobalManager(standardRunTimelineMetricsManager);
taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());
const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);
const devUsageManager = new DevUsageManager();
usage.setGlobalUsageManager(devUsageManager);
const devRuntimeManager = new DevRuntimeManager();
runtime.setGlobalRuntimeManager(devRuntimeManager);
timeout.setGlobalManager(new UsageTimeoutManager(devUsageManager));
const runMetadataManager = new StandardMetadataManager(
  apiClientManager.clientOrThrow(),
  getEnvVar("TRIGGER_STREAM_URL", getEnvVar("TRIGGER_API_URL")) ?? "https://api.trigger.dev",
  (getEnvVar("TRIGGER_REALTIME_STREAM_VERSION") ?? "v1") as "v1" | "v2"
);
runMetadata.setGlobalManager(runMetadataManager);
const waitUntilManager = new StandardWaitUntilManager();
waitUntil.setGlobalManager(waitUntilManager);
// Wait for all streams to finish before completing the run
waitUntil.register({
  requiresResolving: () => runMetadataManager.hasActiveStreams(),
  promise: () => runMetadataManager.waitForAllStreams(),
});

const triggerLogLevel = getEnvVar("TRIGGER_LOG_LEVEL");

standardRunTimelineMetricsManager.seedMetricsFromEnvironment();

async function importConfig(
  configPath: string
): Promise<{ config: TriggerConfig; handleError?: HandleErrorFunction }> {
  const configModule = await import(normalizeImportPath(configPath));

  const config = configModule?.default ?? configModule?.config;

  return {
    config,
    handleError: configModule?.handleError,
  };
}

async function loadWorkerManifest() {
  const manifestContents = await readFile(env.TRIGGER_WORKER_MANIFEST_PATH!, "utf-8");
  const raw = JSON.parse(manifestContents);

  return WorkerManifest.parse(raw);
}

async function bootstrap() {
  const workerManifest = await loadWorkerManifest();

  const { config, handleError } = await importConfig(workerManifest.configPath);

  const tracingSDK = new TracingSDK({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
    instrumentations: config.telemetry?.instrumentations ?? config.instrumentations ?? [],
    exporters: config.telemetry?.exporters ?? [],
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
    EXECUTE_TASK_RUN: async ({ execution, traceContext, metadata, metrics }, sender) => {
      standardRunTimelineMetricsManager.registerMetricsFromExecution(metrics);

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
            taskIdentifier: execution.task.id,
          },
        });

        return;
      }

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
            taskIdentifier: execution.task.id,
          },
        });

        return;
      }

      try {
        await runTimelineMetrics.measureMetric(
          "trigger.dev/start",
          "import",
          {
            entryPoint: taskManifest.entryPoint,
          },
          async () => {
            await import(normalizeImportPath(taskManifest.entryPoint));
          }
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
              message: err instanceof Error ? err.message : String(err),
              stackTrace: err instanceof Error ? err.stack : undefined,
            },
            usage: {
              durationMs: 0,
            },
            taskIdentifier: execution.task.id,
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
            taskIdentifier: execution.task.id,
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

        runMetadataManager.runId = execution.run.id;

        runMetadataManager.startPeriodicFlush(
          getNumberEnvVar("TRIGGER_RUN_METADATA_FLUSH_INTERVAL", 1000)
        );
        const measurement = usage.start();

        // This lives outside of the executor because this will eventually be moved to the controller level
        const signal = execution.run.maxDuration
          ? timeout.abortAfterTimeout(execution.run.maxDuration)
          : undefined;

        signal?.addEventListener("abort", async (e) => {
          if (_isRunning) {
            _isRunning = false;
            _execution = undefined;

            const usageSample = usage.stop(measurement);

            await sender.send("TASK_RUN_COMPLETED", {
              execution,
              result: {
                ok: false,
                id: execution.run.id,
                error: {
                  type: "INTERNAL_ERROR",
                  code: TaskRunErrorCodes.MAX_DURATION_EXCEEDED,
                  message:
                    signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
                },
                usage: {
                  durationMs: usageSample.cpuTime,
                },
                taskIdentifier: execution.task.id,
                metadata: runMetadataManager.stopAndReturnLastFlush(),
              },
            });
          }
        });

        const { result } = await executor.execute(
          execution,
          metadata,
          traceContext,
          measurement,
          signal
        );

        const usageSample = usage.stop(measurement);

        if (_isRunning) {
          return sender.send("TASK_RUN_COMPLETED", {
            execution,
            result: {
              ...result,
              usage: {
                durationMs: usageSample.cpuTime,
              },
              taskIdentifier: execution.task.id,
              metadata: runMetadataManager.stopAndReturnLastFlush(),
            },
          });
        }
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
    FLUSH: async ({ timeoutInMs }, sender) => {
      await Promise.allSettled([_tracingSDK?.flush(), runMetadataManager.flush()]);
    },
  },
});

process.title = "trigger-dev-worker";

async function asyncHeartbeat(initialDelayInSeconds: number = 30, intervalInSeconds: number = 30) {
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

await asyncHeartbeat();
