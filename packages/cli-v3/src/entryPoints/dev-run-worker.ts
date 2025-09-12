import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import {
  AnyOnCatchErrorHookFunction,
  AnyOnFailureHookFunction,
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  AnyOnSuccessHookFunction,
  apiClientManager,
  attemptKey,
  clock,
  ExecutorToWorkerMessageCatalog,
  type HandleErrorFunction,
  lifecycleHooks,
  localsAPI,
  logger,
  LogLevel,
  OTEL_LOG_ATTRIBUTE_COUNT_LIMIT,
  resourceCatalog,
  runMetadata,
  runtime,
  runTimelineMetrics,
  taskContext,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecution,
  timeout,
  TriggerConfig,
  UsageMeasurement,
  waitUntil,
  WorkerManifest,
  WorkerToExecutorMessageCatalog,
  traceContext,
  heartbeats,
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
  StandardTraceContextManager,
  StandardHeartbeatsManager,
} from "@trigger.dev/core/v3/workers";
import { ZodIpcConnection } from "@trigger.dev/core/v3/zodIpc";
import { readFile } from "node:fs/promises";
import { setInterval, setTimeout } from "node:timers/promises";
import sourceMapSupport from "source-map-support";
import { env } from "std-env";
import { normalizeImportPath } from "../utilities/normalizeImportPath.js";
import { VERSION } from "../version.js";
import { promiseWithResolvers } from "@trigger.dev/core/utils";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

process.on("uncaughtException", function (error, origin) {
  logError("Uncaught exception", { error, origin });
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

process.title = `trigger-dev-run-worker (${
  getEnvVar("TRIGGER_WORKER_VERSION") ?? "unknown version"
})`;

const heartbeatIntervalMs = getEnvVar("HEARTBEAT_INTERVAL_MS");

const standardLocalsManager = new StandardLocalsManager();
localsAPI.setGlobalLocalsManager(standardLocalsManager);

const standardLifecycleHooksManager = new StandardLifecycleHooksManager();
lifecycleHooks.setGlobalLifecycleHooksManager(standardLifecycleHooksManager);

const standardRunTimelineMetricsManager = new StandardRunTimelineMetricsManager();
runTimelineMetrics.setGlobalManager(standardRunTimelineMetricsManager);

const devUsageManager = new DevUsageManager();
usage.setGlobalUsageManager(devUsageManager);

const usageTimeoutManager = new UsageTimeoutManager(devUsageManager);
timeout.setGlobalManager(usageTimeoutManager);

const standardResourceCatalog = new StandardResourceCatalog();
resourceCatalog.setGlobalResourceCatalog(standardResourceCatalog);

const standardTraceContextManager = new StandardTraceContextManager();
traceContext.setGlobalManager(standardTraceContextManager);

const durableClock = new DurableClock();
clock.setGlobalClock(durableClock);
const runMetadataManager = new StandardMetadataManager(
  apiClientManager.clientOrThrow(),
  getEnvVar("TRIGGER_STREAM_URL", getEnvVar("TRIGGER_API_URL")) ?? "https://api.trigger.dev"
);
runMetadata.setGlobalManager(runMetadataManager);
const waitUntilManager = new StandardWaitUntilManager();
waitUntil.setGlobalManager(waitUntilManager);

const triggerLogLevel = getEnvVar("TRIGGER_LOG_LEVEL");
const showInternalLogs = getEnvVar("RUN_WORKER_SHOW_LOGS") === "true";

const standardHeartbeatsManager = new StandardHeartbeatsManager(
  parseInt(heartbeatIntervalMs ?? "30000", 10)
);
heartbeats.setGlobalManager(standardHeartbeatsManager);

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

async function doBootstrap() {
  return await runTimelineMetrics.measureMetric("trigger.dev/start", "bootstrap", {}, async () => {
    log("Bootstrapping worker");

    const workerManifest = await loadWorkerManifest();

    resourceCatalog.registerWorkerManifest(workerManifest);

    const { config, handleError } = await importConfig(workerManifest.configPath);

    const tracingSDK = new TracingSDK({
      url: env.TRIGGER_OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
      instrumentations: config.telemetry?.instrumentations ?? config.instrumentations ?? [],
      exporters: config.telemetry?.exporters ?? [],
      logExporters: config.telemetry?.logExporters ?? [],
      diagLogLevel: (env.TRIGGER_OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
      forceFlushTimeoutMillis: 30_000,
    });

    const otelTracer: Tracer = tracingSDK.getTracer("trigger-dev-worker", VERSION);
    const otelLogger: Logger = tracingSDK.getLogger("trigger-dev-worker", VERSION);

    const tracer = new TriggerTracer({ tracer: otelTracer, logger: otelLogger });
    const consoleInterceptor = new ConsoleInterceptor(
      otelLogger,
      typeof config.enableConsoleLogging === "boolean" ? config.enableConsoleLogging : true,
      typeof config.disableConsoleInterceptor === "boolean"
        ? config.disableConsoleInterceptor
        : false,
      OTEL_LOG_ATTRIBUTE_COUNT_LIMIT
    );

    const configLogLevel = triggerLogLevel ?? config.logLevel ?? "info";

    const otelTaskLogger = new OtelTaskLogger({
      logger: otelLogger,
      tracer: tracer,
      level: logLevels.includes(configLogLevel as any) ? (configLogLevel as LogLevel) : "info",
      maxAttributeCount: OTEL_LOG_ATTRIBUTE_COUNT_LIMIT,
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

    log("Bootstrapped worker");

    return {
      tracer,
      tracingSDK,
      consoleInterceptor,
      config,
      workerManifest,
    };
  });
}

let bootstrapCache:
  | {
      tracer: TriggerTracer;
      tracingSDK: TracingSDK;
      consoleInterceptor: ConsoleInterceptor;
      config: TriggerConfig;
      workerManifest: WorkerManifest;
    }
  | undefined;

async function bootstrap() {
  if (!bootstrapCache) {
    bootstrapCache = await doBootstrap();
  }

  return bootstrapCache;
}

let _execution: TaskRunExecution | undefined;
let _isRunning = false;
let _isCancelled = false;
let _tracingSDK: TracingSDK | undefined;
let _executionMeasurement: UsageMeasurement | undefined;
let _cancelController = new AbortController();
let _lastFlushPromise: Promise<void> | undefined;
let _sharedWorkerRuntime: SharedRuntimeManager | undefined;

let _lastEnv: Record<string, string> | undefined;
let _executionCount = 0;

function resetExecutionEnvironment() {
  _execution = undefined;
  _isRunning = false;
  _isCancelled = false;
  _executionMeasurement = undefined;
  _cancelController = new AbortController();

  standardLocalsManager.reset();
  standardLifecycleHooksManager.reset();
  standardRunTimelineMetricsManager.reset();
  devUsageManager.reset();
  usageTimeoutManager.reset();
  runMetadataManager.reset();
  waitUntilManager.reset();
  _sharedWorkerRuntime?.reset();
  durableClock.reset();
  taskContext.disable();
  standardTraceContextManager.reset();
  standardHeartbeatsManager.reset();

  // Wait for all streams to finish before completing the run
  waitUntil.register({
    requiresResolving: () => runMetadataManager.hasActiveStreams(),
    promise: () => runMetadataManager.waitForAllStreams(),
  });

  log(`[${new Date().toISOString()}] Reset execution environment`);
}

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
          previousEnv: _lastEnv,
        });

        _lastEnv = env;
      }

      log(`[${new Date().toISOString()}] Received EXECUTE_TASK_RUN`, execution);

      if (_lastFlushPromise) {
        const now = performance.now();

        await _lastFlushPromise;

        const duration = performance.now() - now;

        log(`[${new Date().toISOString()}] Awaited last flush in ${duration}ms`);
      }

      resetExecutionEnvironment();

      standardTraceContextManager.traceContext = traceContext;
      standardRunTimelineMetricsManager.registerMetricsFromExecution(metrics, isWarmStart);

      if (_isRunning) {
        logError("Worker is already running a task");

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
            flushedMetadata: await runMetadataManager.stopAndReturnLastFlush(),
          },
        });

        return;
      }

      const ctx = TaskRunContext.parse(execution);

      taskContext.setGlobalTaskContext({
        ctx,
        worker: metadata,
        isWarmStart: isWarmStart ?? false,
      });

      try {
        const { tracer, tracingSDK, consoleInterceptor, config, workerManifest } =
          await bootstrap();

        _tracingSDK = tracingSDK;

        const taskManifest = workerManifest.tasks.find((t) => t.id === execution.task.id);

        if (!taskManifest) {
          logError(`Could not find task ${execution.task.id}`);

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
              flushedMetadata: await runMetadataManager.stopAndReturnLastFlush(),
            },
          });

          return;
        }

        // First attempt to get the task from the resource catalog
        let task = resourceCatalog.getTask(execution.task.id);

        if (!task) {
          log(`Could not find task ${execution.task.id} in resource catalog, importing...`);

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
                resourceCatalog.setCurrentFileContext(
                  taskManifest.entryPoint,
                  taskManifest.filePath
                );

                // Load init file if it exists
                if (workerManifest.initEntryPoint) {
                  try {
                    await import(normalizeImportPath(workerManifest.initEntryPoint));
                    log(`Loaded init file from ${workerManifest.initEntryPoint}`);
                  } catch (err) {
                    logError(`Failed to load init file`, err);
                    throw err;
                  }
                }

                await import(normalizeImportPath(taskManifest.entryPoint));
                resourceCatalog.clearCurrentFileContext();
                const durationMs = performance.now() - beforeImport;

                log(
                  `Imported task ${execution.task.id} [${taskManifest.entryPoint}] in ${durationMs}ms`
                );
              }
            );
          } catch (err) {
            logError(`Failed to import task ${execution.task.id}`, err);

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
                flushedMetadata: await runMetadataManager.stopAndReturnLastFlush(),
              },
            });

            return;
          }

          // Now try and get the task again
          task = resourceCatalog.getTask(execution.task.id);
        }

        if (!task) {
          logError(`Could not find task ${execution.task.id}`);

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
              flushedMetadata: await runMetadataManager.stopAndReturnLastFlush(),
            },
          });

          return;
        }

        runMetadataManager.runId = execution.run.id;
        runMetadataManager.runIdIsRoot = typeof execution.run.rootTaskRunId === "undefined";

        _executionCount++;

        const executor = new TaskExecutor(task, {
          tracer,
          tracingSDK,
          consoleInterceptor,
          retries: config.retries,
          isWarmStart,
          executionCount: _executionCount,
        });

        try {
          _execution = execution;
          _isRunning = true;

          standardHeartbeatsManager.startHeartbeat(attemptKey(execution));

          runMetadataManager.startPeriodicFlush(
            getNumberEnvVar("TRIGGER_RUN_METADATA_FLUSH_INTERVAL", 1000)
          );

          devUsageManager.setInitialState({
            cpuTime: execution.run.durationMs ?? 0,
            costInCents: execution.run.costInCents ?? 0,
          });

          _executionMeasurement = usage.start();

          const timeoutController = timeout.abortAfterTimeout(execution.run.maxDuration);

          const signal = AbortSignal.any([_cancelController.signal, timeoutController.signal]);

          const { result } = await executor.execute(execution, ctx, signal);

          if (_isRunning && !_isCancelled) {
            const usageSample = usage.stop(_executionMeasurement);

            return sender.send("TASK_RUN_COMPLETED", {
              execution,
              result: {
                ...result,
                usage: {
                  durationMs: usageSample.cpuTime,
                },
                flushedMetadata: await runMetadataManager.stopAndReturnLastFlush(),
              },
            });
          }
        } finally {
          standardHeartbeatsManager.stopHeartbeat();

          _execution = undefined;
          _isRunning = false;
          log(`[${new Date().toISOString()}] Task run completed`);
        }
      } catch (err) {
        logError("Failed to execute task", err);

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
            flushedMetadata: await runMetadataManager.stopAndReturnLastFlush(),
          },
        });
      }
    },
    CANCEL: async ({ timeoutInMs }) => {
      _isCancelled = true;
      _cancelController.abort("run cancelled");
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
      _sharedWorkerRuntime?.resolveWaitpoints([waitpoint]);
    },
  },
});

async function callCancelHooks(timeoutInMs: number = 10_000) {
  const now = performance.now();

  try {
    await Promise.race([lifecycleHooks.callOnCancelHookListeners(), setTimeout(timeoutInMs)]);
  } finally {
    const duration = performance.now() - now;

    log(`Called cancel hooks in ${duration}ms`);
  }
}

async function flushAll(timeoutInMs: number = 10_000) {
  const now = performance.now();

  const { promise, resolve } = promiseWithResolvers<void>();

  _lastFlushPromise = promise;

  const results = await Promise.allSettled([
    flushTracingSDK(timeoutInMs),
    flushMetadata(timeoutInMs),
  ]);

  const successfulFlushes = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value.flushed);

  const failedFlushes = ["tracingSDK", "runMetadata"].filter(
    (flushed) => !successfulFlushes.includes(flushed)
  );

  if (failedFlushes.length > 0) {
    logError(`Failed to flush ${failedFlushes.join(", ")}`);
  }

  const errorMessages = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);

  if (errorMessages.length > 0) {
    logError(errorMessages.join("\n"));
  }

  for (const flushed of successfulFlushes) {
    log(`Flushed ${flushed} successfully`);
  }

  const duration = performance.now() - now;

  log(`Flushed all in ${duration}ms`);

  // Resolve the last flush promise
  resolve();
}

async function flushTracingSDK(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([_tracingSDK?.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  log(`Flushed tracingSDK in ${duration}ms`);

  return {
    flushed: "tracingSDK",
    durationMs: duration,
  };
}

async function flushMetadata(timeoutInMs: number = 10_000) {
  const now = performance.now();

  await Promise.race([runMetadataManager.flush(), setTimeout(timeoutInMs)]);

  const duration = performance.now() - now;

  log(`Flushed runMetadata in ${duration}ms`);

  return {
    flushed: "runMetadata",
    durationMs: duration,
  };
}

_sharedWorkerRuntime = new SharedRuntimeManager(zodIpc, showInternalLogs);
runtime.setGlobalRuntimeManager(_sharedWorkerRuntime);

standardHeartbeatsManager.registerListener(async (id) => {
  await zodIpc.send("TASK_HEARTBEAT", { id });
});

function log(message: string, ...args: any[]) {
  if (!showInternalLogs) return;
  console.log(`[${new Date().toISOString()}] ${message}`, args);
}

function logError(message: string, error?: any) {
  if (!showInternalLogs) return;
  console.error(`[${new Date().toISOString()}] ${message}`, error);
}

log(`Executor started`);
