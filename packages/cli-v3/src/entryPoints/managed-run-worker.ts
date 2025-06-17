import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  AnyOnCatchErrorHookFunction,
  AnyOnFailureHookFunction,
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  AnyOnSuccessHookFunction,
  apiClientManager,
  clock,
  ExecutorToWorkerMessageCatalog,
  type HandleErrorFunction,
  lifecycleHooks,
  localsAPI,
  logger,
  LogLevel,
  resourceCatalog,
  runMetadata,
  runtime,
  runTimelineMetrics,
  TaskRunErrorCodes,
  TaskRunExecution,
  timeout,
  TriggerConfig,
  UsageMeasurement,
  waitUntil,
  WorkerManifest,
  WorkerToExecutorMessageCatalog,
} from "@trigger.dev/core/v3";
import { TriggerTracer } from "@trigger.dev/core/v3/tracer";
import {
  ConsoleInterceptor,
  DevUsageManager,
  DurableClock,
  getEnvVar,
  getNumberEnvVar,
  logLevels,
  SharedRuntimeManager,
  OtelTaskLogger,
  populateEnv,
  ProdUsageManager,
  StandardLifecycleHooksManager,
  StandardLocalsManager,
  StandardMetadataManager,
  StandardResourceCatalog,
  StandardRunTimelineMetricsManager,
  StandardWaitUntilManager,
  TaskExecutor,
  TracingDiagnosticLogLevel,
  TracingSDK,
  usage,
  UsageTimeoutManager,
} from "@trigger.dev/core/v3/workers";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { readFile } from "node:fs/promises";
import { setInterval, setTimeout } from "node:timers/promises";
import sourceMapSupport from "source-map-support";
import { env } from "std-env";
import { normalizeImportPath } from "../utilities/normalizeImportPath.js";
import { VERSION } from "../version.js";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

process.on("uncaughtException", function (error, origin) {
  console.error("Uncaught exception", { error, origin });
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

const heartbeatIntervalMs = getEnvVar("HEARTBEAT_INTERVAL_MS");

const standardLocalsManager = new StandardLocalsManager();
localsAPI.setGlobalLocalsManager(standardLocalsManager);

const standardLifecycleHooksManager = new StandardLifecycleHooksManager();
lifecycleHooks.setGlobalLifecycleHooksManager(standardLifecycleHooksManager);

const standardRunTimelineMetricsManager = new StandardRunTimelineMetricsManager();
runTimelineMetrics.setGlobalManager(standardRunTimelineMetricsManager);

resourceCatalog.setGlobalResourceCatalog(new StandardResourceCatalog());

const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);
const runMetadataManager = new StandardMetadataManager(
  apiClientManager.clientOrThrow(),
  getEnvVar("TRIGGER_STREAM_URL", getEnvVar("TRIGGER_API_URL")) ?? "https://api.trigger.dev"
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

  resourceCatalog.registerWorkerManifest(workerManifest);

  const { config, handleError } = await importConfig(
    normalizeImportPath(workerManifest.configPath)
  );

  const tracingSDK = new TracingSDK({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
    instrumentations: config.instrumentations ?? [],
    diagLogLevel: (env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
    forceFlushTimeoutMillis: 30_000,
    exporters: config.telemetry?.exporters ?? [],
    logExporters: config.telemetry?.logExporters ?? [],
  });

  const otelTracer: Tracer = tracingSDK.getTracer("trigger-dev-worker", VERSION);
  const otelLogger: Logger = tracingSDK.getLogger("trigger-dev-worker", VERSION);

  const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
  const consoleInterceptor = new ConsoleInterceptor(
    otelLogger,
    typeof config.enableConsoleLogging === "boolean" ? config.enableConsoleLogging : true,
    typeof config.disableConsoleInterceptor === "boolean" ? config.disableConsoleInterceptor : false
  );

  const configLogLevel = triggerLogLevel ?? config.logLevel ?? "info";

  const otelTaskLogger = new OtelTaskLogger({
    logger: otelLogger,
    tracer: tracer,
    level: logLevels.includes(configLogLevel as any) ? (configLogLevel as LogLevel) : "info",
  });

  logger.setGlobalTaskLogger(otelTaskLogger);

  if (config.init) {
    lifecycleHooks.registerGlobalInitHook({
      id: "config",
      fn: config.init as AnyOnInitHookFunction,
    });
  }

  if (config.onStart) {
    lifecycleHooks.registerGlobalStartHook({
      id: "config",
      fn: config.onStart as AnyOnStartHookFunction,
    });
  }

  if (config.onSuccess) {
    lifecycleHooks.registerGlobalSuccessHook({
      id: "config",
      fn: config.onSuccess as AnyOnSuccessHookFunction,
    });
  }

  if (config.onFailure) {
    lifecycleHooks.registerGlobalFailureHook({
      id: "config",
      fn: config.onFailure as AnyOnFailureHookFunction,
    });
  }

  if (handleError) {
    lifecycleHooks.registerGlobalCatchErrorHook({
      id: "config",
      fn: handleError as AnyOnCatchErrorHookFunction,
    });
  }

  return {
    tracer,
    tracingSDK,
    consoleInterceptor,
    config,
    workerManifest,
  };
}

let _execution: TaskRunExecution | undefined;
let _isRunning = false;
let _isCancelled = false;
let _tracingSDK: TracingSDK | undefined;
let _executionMeasurement: UsageMeasurement | undefined;
const cancelController = new AbortController();

const zodIpc = new ZodIpcConnection({
  listenSchema: WorkerToExecutorMessageCatalog,
  emitSchema: ExecutorToWorkerMessageCatalog,
  process,
  handlers: {
    EXECUTE_TASK_RUN: async (
      { execution, traceContext, metadata, metrics, env, isWarmStart },
      sender
    ) => {
      if (env) {
        populateEnv(env, {
          override: true,
        });
      }

      initializeUsageManager({
        usageIntervalMs: getEnvVar("USAGE_HEARTBEAT_INTERVAL_MS"),
        usageEventUrl: getEnvVar("USAGE_EVENT_URL"),
        triggerJWT: getEnvVar("TRIGGER_JWT"),
      });

      standardRunTimelineMetricsManager.registerMetricsFromExecution(metrics, isWarmStart);

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
            metadata: runMetadataManager.stopAndReturnLastFlush(),
          },
        });

        return;
      }

      try {
        const { tracer, tracingSDK, consoleInterceptor, config, workerManifest } =
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
                message: `Could not find task ${execution.task.id}. Make sure the task is exported and the ID is correct.`,
              },
              usage: {
                durationMs: 0,
              },
              metadata: runMetadataManager.stopAndReturnLastFlush(),
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
              file: taskManifest.filePath,
            },
            async () => {
              const beforeImport = performance.now();
              resourceCatalog.setCurrentFileContext(taskManifest.entryPoint, taskManifest.filePath);

              // Load init file if it exists
              if (workerManifest.initEntryPoint) {
                try {
                  await import(normalizeImportPath(workerManifest.initEntryPoint));
                  console.log(`Loaded init file from ${workerManifest.initEntryPoint}`);
                } catch (err) {
                  console.error(`Failed to load init file`, err);
                  throw err;
                }
              }

              await import(normalizeImportPath(taskManifest.entryPoint));
              resourceCatalog.clearCurrentFileContext();
              const durationMs = performance.now() - beforeImport;

              console.log(
                `Imported task ${execution.task.id} [${taskManifest.entryPoint}] in ${durationMs}ms`
              );
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
              metadata: runMetadataManager.stopAndReturnLastFlush(),
            },
          });

          return;
        }

        process.title = `trigger-dev-worker: ${execution.task.id} ${execution.run.id}`;

        // Import the task module
        const task = resourceCatalog.getTask(execution.task.id);

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
              metadata: runMetadataManager.stopAndReturnLastFlush(),
            },
          });

          return;
        }

        runMetadataManager.runId = execution.run.id;

        const executor = new TaskExecutor(task, {
          tracer,
          tracingSDK,
          consoleInterceptor,
          retries: config.retries,
          isWarmStart,
        });

        try {
          _execution = execution;
          _isRunning = true;

          runMetadataManager.startPeriodicFlush(
            getNumberEnvVar("TRIGGER_RUN_METADATA_FLUSH_INTERVAL", 1000)
          );

          _executionMeasurement = usage.start();

          const timeoutController = timeout.abortAfterTimeout(execution.run.maxDuration);

          const signal = AbortSignal.any([cancelController.signal, timeoutController.signal]);

          const { result } = await executor.execute(execution, metadata, traceContext, signal);

          if (_isRunning && !_isCancelled) {
            const usageSample = usage.stop(_executionMeasurement);

            return sender.send("TASK_RUN_COMPLETED", {
              execution,
              result: {
                ...result,
                usage: {
                  durationMs: usageSample.cpuTime,
                },
                metadata: runMetadataManager.stopAndReturnLastFlush(),
              },
            });
          }
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
              message: err instanceof Error ? err.message : String(err),
              stackTrace: err instanceof Error ? err.stack : undefined,
            },
            usage: {
              durationMs: 0,
            },
            metadata: runMetadataManager.stopAndReturnLastFlush(),
          },
        });
      }
    },
    CANCEL: async ({ timeoutInMs }) => {
      _isCancelled = true;
      cancelController.abort("run cancelled");
      await callCancelHooks(timeoutInMs);
      if (_executionMeasurement) {
        usage.stop(_executionMeasurement);
      }
      await flushAll(timeoutInMs);
    },
    FLUSH: async ({ timeoutInMs }) => {
      await flushAll(timeoutInMs);
    },
    RESOLVE_WAITPOINT: async ({ waitpoint }) => {
      sharedWorkerRuntime.resolveWaitpoints([waitpoint]);
    },
  },
});

async function callCancelHooks(timeoutInMs: number = 10_000) {
  const now = performance.now();

  try {
    await Promise.race([lifecycleHooks.callOnCancelHookListeners(), setTimeout(timeoutInMs)]);
  } finally {
    const duration = performance.now() - now;

    console.log(`Called cancel hooks in ${duration}ms`);
  }
}

async function flushAll(timeoutInMs: number = 10_000) {
  const now = performance.now();

  const results = await Promise.allSettled([
    flushUsage(timeoutInMs),
    flushTracingSDK(timeoutInMs),
    flushMetadata(timeoutInMs),
  ]);

  const successfulFlushes = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value.flushed);
  const failedFlushes = ["usage", "tracingSDK", "runMetadata"].filter(
    (flushed) => !successfulFlushes.includes(flushed)
  );

  if (failedFlushes.length > 0) {
    console.error(`Failed to flush ${failedFlushes.join(", ")}`);
  }

  const errorMessages = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);

  if (errorMessages.length > 0) {
    console.error(errorMessages.join("\n"));
  }

  for (const flushed of successfulFlushes) {
    console.log(`Flushed ${flushed} successfully`);
  }

  const duration = performance.now() - now;

  console.log(`Flushed all in ${duration}ms`);
}

async function flushUsage(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([usage.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  console.log(`Flushed usage in ${duration}ms`);

  return {
    flushed: "usage",
    durationMs: duration,
  };
}

async function flushTracingSDK(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([_tracingSDK?.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  console.log(`Flushed tracingSDK in ${duration}ms`);

  return {
    flushed: "tracingSDK",
    durationMs: duration,
  };
}

async function flushMetadata(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([runMetadataManager.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  console.log(`Flushed runMetadata in ${duration}ms`);

  return {
    flushed: "runMetadata",
    durationMs: duration,
  };
}

function initializeUsageManager({
  usageIntervalMs,
  usageEventUrl,
  triggerJWT,
}: {
  usageIntervalMs?: string;
  usageEventUrl?: string;
  triggerJWT?: string;
}) {
  const devUsageManager = new DevUsageManager();
  const prodUsageManager = new ProdUsageManager(devUsageManager, {
    heartbeatIntervalMs: usageIntervalMs ? parseInt(usageIntervalMs, 10) : undefined,
    url: usageEventUrl,
    jwt: triggerJWT,
  });

  usage.setGlobalUsageManager(prodUsageManager);
  timeout.setGlobalManager(new UsageTimeoutManager(devUsageManager));
}

const sharedWorkerRuntime = new SharedRuntimeManager(zodIpc, true);

runtime.setGlobalRuntimeManager(sharedWorkerRuntime);

process.title = "trigger-managed-worker";

const heartbeatInterval = parseInt(heartbeatIntervalMs ?? "30000", 10);

for await (const _ of setInterval(heartbeatInterval)) {
  if (_isRunning && _execution) {
    try {
      await zodIpc.send("TASK_HEARTBEAT", { id: _execution.run.id });
    } catch (err) {
      console.error("Failed to send HEARTBEAT message", err);
    }
  }
}

console.log(`[${new Date().toISOString()}] Executor started`);
