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
import { detectRuntimeVersion } from "@trigger.dev/core/v3/build";
import { schemaToJsonSchema } from "@trigger.dev/schema-to-json";

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

let tasks = await convertSchemasToJsonSchemas(resourceCatalog.listTaskManifests());

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

const processKeepAlive = config.processKeepAlive ?? config.experimental_processKeepAlive;

await sendMessageInCatalog(
  indexerToWorkerMessages,
  "INDEX_COMPLETE",
  {
    manifest: {
      tasks,
      queues: resourceCatalog.listQueueManifests(),
      configPath: buildManifest.configPath,
      runtime: buildManifest.runtime,
      runtimeVersion: detectRuntimeVersion(),
      workerEntryPoint: buildManifest.runWorkerEntryPoint,
      controllerEntryPoint: buildManifest.runControllerEntryPoint,
      loaderEntryPoint: buildManifest.loaderEntryPoint,
      customConditions: buildManifest.customConditions,
      initEntryPoint: buildManifest.initEntryPoint,
      processKeepAlive:
        typeof processKeepAlive === "object"
          ? processKeepAlive
          : typeof processKeepAlive === "boolean"
          ? { enabled: processKeepAlive }
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

async function convertSchemasToJsonSchemas(tasks: TaskManifest[]): Promise<TaskManifest[]> {
  const convertedTasks = tasks.map((task) => {
    const schema = resourceCatalog.getTaskSchema(task.id);

    if (schema) {
      try {
        const result = schemaToJsonSchema(schema);
        return { ...task, payloadSchema: result?.jsonSchema };
      } catch {
        return task;
      }
    }

    return task;
  });

  return convertedTasks;
}
