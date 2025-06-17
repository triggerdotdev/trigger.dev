import {
  BuildManifest,
  type HandleErrorFunction,
  indexerToWorkerMessages,
  resourceCatalog,
  type TaskManifest,
  TriggerConfig,
} from "@trigger.dev/core/v3";
import {
  StandardResourceCatalog,
  TracingDiagnosticLogLevel,
  TracingSDK,
} from "@trigger.dev/core/v3/workers";
import { sendMessageInCatalog, ZodSchemaParsedError } from "@trigger.dev/core/v3/zodMessageHandler";
import { readFile } from "node:fs/promises";
import sourceMapSupport from "source-map-support";
import { registerResources } from "../indexing/registerResources.js";
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

resourceCatalog.setGlobalResourceCatalog(new StandardResourceCatalog());

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

async function loadBuildManifest() {
  const manifestContents = await readFile(env.TRIGGER_BUILD_MANIFEST_PATH!, "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

async function bootstrap() {
  const buildManifest = await loadBuildManifest();

  const { config } = await importConfig(buildManifest.configPath);

  // This needs to run or the PrismaInstrumentation will throw an error
  const tracingSDK = new TracingSDK({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
    instrumentations: config.instrumentations ?? [],
    diagLogLevel: (env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
    forceFlushTimeoutMillis: 30_000,
  });

  const { importErrors, timings } = await registerResources(buildManifest);

  return {
    tracingSDK,
    config,
    buildManifest,
    importErrors,
    timings,
  };
}

const { buildManifest, importErrors, config, timings } = await bootstrap();

let tasks = resourceCatalog.listTaskManifests();

// If the config has retry defaults, we need to apply them to all tasks that don't have any retry settings
if (config.retries?.default) {
  tasks = tasks.map((task) => {
    if (!task.retry) {
      return {
        ...task,
        retry: config.retries?.default,
      } satisfies TaskManifest;
    }

    return task;
  });
}

// If the config has a maxDuration, we need to apply it to all tasks that don't have a maxDuration
if (typeof config.maxDuration === "number") {
  tasks = tasks.map((task) => {
    if (typeof task.maxDuration !== "number") {
      return {
        ...task,
        maxDuration: config.maxDuration,
      } satisfies TaskManifest;
    }

    return task;
  });
}

// If the config has a machine preset, we need to apply it to all tasks that don't have a machine preset
if (typeof config.machine === "string") {
  tasks = tasks.map((task) => {
    if (typeof task.machine?.preset !== "string") {
      return {
        ...task,
        machine: {
          preset: config.machine,
        },
      } satisfies TaskManifest;
    }

    return task;
  });
}

await sendMessageInCatalog(
  indexerToWorkerMessages,
  "INDEX_COMPLETE",
  {
    manifest: {
      tasks,
      queues: resourceCatalog.listQueueManifests(),
      configPath: buildManifest.configPath,
      runtime: buildManifest.runtime,
      workerEntryPoint: buildManifest.runWorkerEntryPoint,
      controllerEntryPoint: buildManifest.runControllerEntryPoint,
      loaderEntryPoint: buildManifest.loaderEntryPoint,
      customConditions: buildManifest.customConditions,
      initEntryPoint: buildManifest.initEntryPoint,
      processKeepAlive:
        typeof config.experimental_processKeepAlive === "object"
          ? config.experimental_processKeepAlive
          : typeof config.experimental_processKeepAlive === "boolean"
          ? { enabled: config.experimental_processKeepAlive }
          : undefined,
      timings,
    },
    importErrors,
  },
  async (msg) => {
    process.send?.(msg);
  }
).catch((err) => {
  if (err instanceof ZodSchemaParsedError) {
    return sendMessageInCatalog(
      indexerToWorkerMessages,
      "TASKS_FAILED_TO_PARSE",
      { zodIssues: err.error.issues, tasks },
      async (msg) => {
        process.send?.(msg);
      }
    );
  } else {
    console.error("Failed to send TASKS_READY message", err);
  }

  return;
});

await new Promise<void>((resolve) => {
  setTimeout(() => {
    resolve();
  }, 10);
});
