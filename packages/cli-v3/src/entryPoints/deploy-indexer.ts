import {
  BuildManifest,
  CreateBackgroundWorkerRequestBody,
  type HandleErrorFunction,
  taskCatalog,
  TriggerConfig,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import {
  StandardTaskCatalog,
  TracingDiagnosticLogLevel,
  TracingSDK,
} from "@trigger.dev/core/v3/workers";
import { readFile, writeFile } from "node:fs/promises";
import sourceMapSupport from "source-map-support";
import { CliApiClient } from "../apiClient.js";
import { resolveTaskSourceFiles } from "../utilities/sourceFiles.js";
import { join } from "node:path";

sourceMapSupport.install({
  handleUncaughtExceptions: false,
  environment: "node",
  hookRequire: false,
});

taskCatalog.setGlobalTaskCatalog(new StandardTaskCatalog());

async function importConfig(configPath: string): Promise<{
  config: TriggerConfig;
  handleError?: HandleErrorFunction;
}> {
  const configModule = await import(configPath);

  const config = configModule?.default ?? configModule?.config;

  return {
    config,
    handleError: configModule?.handleError,
  };
}

async function loadBuildManifest() {
  const manifestContents = await readFile("./build.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

// We need to make sure, that if any errors are thrown, that we fail the deployment

// 1. Fetch the build manifest
// 2. Fetch the environment variables from the server
// 3. Import the config
// 5. Inject the env vars into process.env
// 6. Configure the tracing SDK
// 7. Load all the tasks from the build manifest and create the index.json
// 8. Write the index.json to the file system
// 9. Update the deployment with the worker index.json
// 10. Exit the process
async function bootstrap() {
  const buildManifest = await loadBuildManifest();

  if (typeof process.env.TRIGGER_API_URL !== "string") {
    console.error("TRIGGER_API_URL is not set");
    process.exit(1);
  }

  const cliApiClient = new CliApiClient(
    process.env.TRIGGER_API_URL,
    process.env.TRIGGER_SECRET_KEY
  );

  if (!process.env.TRIGGER_PROJECT_REF) {
    console.error("TRIGGER_PROJECT_REF is not set");
    process.exit(1);
  }

  if (!process.env.TRIGGER_DEPLOYMENT_ID) {
    console.error("TRIGGER_DEPLOYMENT_ID is not set");
    process.exit(1);
  }

  return {
    buildManifest,
    cliApiClient,
    projectRef: process.env.TRIGGER_PROJECT_REF,
    deploymentId: process.env.TRIGGER_DEPLOYMENT_ID,
  };
}

type BootstrapResult = Awaited<ReturnType<typeof bootstrap>>;

async function indexDeployment({
  cliApiClient,
  projectRef,
  deploymentId,
  buildManifest,
}: BootstrapResult) {
  try {
    const env = await cliApiClient.getEnvironmentVariables(projectRef);

    if (!env.success) {
      throw new Error(`Failed to fetch environment variables: ${env.error}`);
    }

    injectEnvVars(env.data.variables);

    const { config } = await importConfig(buildManifest.configPath);

    // This needs to run or the PrismaInstrumentation will throw an error
    new TracingSDK({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://0.0.0.0:4318",
      instrumentations: config.instrumentations ?? [],
      diagLogLevel: (process.env.OTEL_LOG_LEVEL as TracingDiagnosticLogLevel) ?? "none",
      forceFlushTimeoutMillis: 30_000,
    });

    const importErrors: Array<{ error: Error; file: string }> = [];

    for (const file of buildManifest.files) {
      const [error, module] = await $import(file.out);

      if (error) {
        importErrors.push({ error, file: file.entry });

        continue;
      }

      for (const exportName of getExportNames(module)) {
        const task = module[exportName] ?? module.default?.[exportName];

        if (!task) {
          continue;
        }

        if (task[Symbol.for("trigger.dev/task")]) {
          if (taskCatalog.taskExists(task.id)) {
            taskCatalog.registerTaskFileMetadata(task.id, {
              exportName,
              filePath: file.entry,
              entryPoint: file.out,
            });
          }
        }
      }
    }

    console.log("Import errors", importErrors);

    if (importErrors.length > 0) {
      const errorMessages = importErrors.map((error) => {
        return `${error.file}: ${error.error.message}`;
      });

      throw new Error(`Failed to index task files:\n${errorMessages.join("\n")}`);
    }

    let tasks = taskCatalog.listTaskManifests();

    if (typeof config.machine === "string") {
      // Set the machine preset on all tasks that don't have it
      tasks = tasks.map((task) => {
        if (typeof task.machine?.preset !== "string") {
          return {
            ...task,
            machine: {
              preset: config.machine,
            },
          };
        }

        return task;
      });
    }

    const workerManifest: WorkerManifest = { tasks, configPath: buildManifest.configPath };

    console.log("Writing index.json", process.cwd());

    await writeFile(join(process.cwd(), "index.json"), JSON.stringify(workerManifest, null, 2));

    const sourceFiles = resolveTaskSourceFiles(buildManifest.sources, workerManifest.tasks);

    const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
      localOnly: true,
      metadata: {
        contentHash: buildManifest.contentHash,
        packageVersion: buildManifest.packageVersion,
        cliPackageVersion: buildManifest.cliPackageVersion,
        tasks: workerManifest.tasks,
        sourceFiles,
      },
      supportsLazyAttempts: true,
    };

    await cliApiClient.createDeploymentBackgroundWorker(deploymentId, backgroundWorkerBody);
  } catch (error) {
    // If we have an error, we need to fail the deployment
    await cliApiClient.failDeployment(deploymentId, {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : {
              name: "Error",
              message: String(error),
            },
    });

    throw error;
  }
}

const results = await bootstrap();

await indexDeployment(results);

function getExportNames(module: any) {
  const exports: string[] = [];

  const exportKeys = Object.keys(module);

  if (exportKeys.length === 0) {
    return exports;
  }

  if (exportKeys.length === 1 && exportKeys[0] === "default") {
    return Object.keys(module.default);
  }

  return exportKeys;
}

type Result<T> = [Error | null, T | null];

async function $import(path: string): Promise<Result<any>> {
  try {
    const module = await import(path);

    return [null, module];
  } catch (error) {
    return [error as Error, null];
  }
}

function injectEnvVars(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}
