import {
  BuildManifest,
  CreateBackgroundWorkerRequestBody,
  serializeIndexingError,
} from "@trigger.dev/core/v3";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { indexWorkerManifest } from "../indexing/indexWorkerManifest.js";
import { resolveSourceFiles } from "../utilities/sourceFiles.js";
import { execOptionsForRuntime } from "@trigger.dev/core/v3/build";
import { writeJSONFile } from "../utilities/fileSystem.js";

async function loadBuildManifest() {
  const manifestContents = await readFile("./build.json", "utf-8");
  const raw = JSON.parse(manifestContents);

  return BuildManifest.parse(raw);
}

async function bootstrap() {
  const buildManifest = await loadBuildManifest();

  if (typeof env.TRIGGER_API_URL !== "string") {
    console.error("TRIGGER_API_URL is not set");
    process.exit(1);
  }

  const cliApiClient = new CliApiClient(
    env.TRIGGER_API_URL,
    env.TRIGGER_SECRET_KEY,
    env.TRIGGER_PREVIEW_BRANCH
  );

  if (!env.TRIGGER_PROJECT_REF) {
    console.error("TRIGGER_PROJECT_REF is not set");
    process.exit(1);
  }

  if (!env.TRIGGER_DEPLOYMENT_ID) {
    console.error("TRIGGER_DEPLOYMENT_ID is not set");
    process.exit(1);
  }

  return {
    buildManifest,
    cliApiClient,
    projectRef: env.TRIGGER_PROJECT_REF,
    deploymentId: env.TRIGGER_DEPLOYMENT_ID,
  };
}

type BootstrapResult = Awaited<ReturnType<typeof bootstrap>>;

async function indexDeployment({
  cliApiClient,
  projectRef,
  deploymentId,
  buildManifest,
}: BootstrapResult) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const $env = await cliApiClient.getEnvironmentVariables(projectRef);

    if (!$env.success) {
      throw new Error(`Failed to fetch environment variables: ${$env.error}`);
    }

    const workerManifest = await indexWorkerManifest({
      runtime: buildManifest.runtime,
      indexWorkerPath: buildManifest.indexWorkerEntryPoint,
      buildManifestPath: "./build.json",
      nodeOptions: execOptionsForRuntime(buildManifest.runtime, buildManifest),
      env: $env.data.variables,
      otelHookExclude: buildManifest.otelImportHook?.exclude,
      otelHookInclude: buildManifest.otelImportHook?.include,
      handleStdout(data) {
        stdout.push(data);
      },
      handleStderr(data) {
        if (!data.includes("DeprecationWarning")) {
          stderr.push(data);
        }
      },
    });

    console.log("Writing index.json", process.cwd());

    const { timings, ...manifestWithoutTimings } = workerManifest;
    await writeJSONFile(join(process.cwd(), "index.json"), manifestWithoutTimings, true);

    const sourceFiles = resolveSourceFiles(buildManifest.sources, workerManifest.tasks);

    const buildPlatform = process.env.BUILDPLATFORM;
    const targetPlatform = process.env.TARGETPLATFORM;

    const backgroundWorkerBody: CreateBackgroundWorkerRequestBody = {
      localOnly: true,
      metadata: {
        contentHash: buildManifest.contentHash,
        packageVersion: buildManifest.packageVersion,
        cliPackageVersion: buildManifest.cliPackageVersion,
        tasks: workerManifest.tasks,
        queues: workerManifest.queues,
        sourceFiles,
        runtime: workerManifest.runtime,
        runtimeVersion: workerManifest.runtimeVersion,
      },
      engine: "V2",
      supportsLazyAttempts: true,
      buildPlatform,
      targetPlatform,
    };

    const createResponse = await cliApiClient.createDeploymentBackgroundWorker(
      deploymentId,
      backgroundWorkerBody
    );

    if (!createResponse.success) {
      console.error(
        JSON.stringify({
          message: "Failed to create background worker",
          buildPlatform,
          targetPlatform,
          error: createResponse.error,
        })
      );
      // Do NOT fail the deployment, this may be a multi-platform deployment
      return;
    }

    console.log(
      JSON.stringify({
        message: "Background worker created",
        buildPlatform,
        targetPlatform,
        createResponse: createResponse.data,
      })
    );
  } catch (error) {
    const serialiedIndexError = serializeIndexingError(error, stderr.join("\n"));

    console.error("Failed to index deployment", serialiedIndexError);

    await cliApiClient.failDeployment(deploymentId, { error: serialiedIndexError });

    process.exit(1);
  }
}

const results = await bootstrap();

await indexDeployment(results);
