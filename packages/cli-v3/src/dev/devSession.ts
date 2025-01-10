import { CORE_VERSION } from "@trigger.dev/core/v3";
import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { CliApiClient } from "../apiClient.js";
import {
  BundleResult,
  bundleWorker,
  getBundleResultFromBuild,
  logBuildFailure,
  logBuildWarnings,
} from "../build/bundle.js";
import {
  createBuildContext,
  notifyExtensionOnBuildComplete,
  notifyExtensionOnBuildStart,
  resolvePluginsForContext,
} from "../build/extensions.js";
import { createExternalsBuildExtension, resolveAlwaysExternal } from "../build/externals.js";
import { copyManifestToDir } from "../build/manifests.js";
import { devIndexWorker, devRunWorker, telemetryEntryPoint } from "../build/packageModules.js";
import { type DevCommandOptions } from "../commands/dev.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import { resolveFileSources } from "../utilities/sourceFiles.js";
import { clearTmpDirs, EphemeralDirectory, getTmpDir } from "../utilities/tempDirectories.js";
import { VERSION } from "../version.js";
import { startDevOutput } from "./devOutput.js";
import { startWorkerRuntime } from "./workerRuntime.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";

export type DevSessionOptions = {
  name: string | undefined;
  dashboardUrl: string;
  initialMode: "local";
  showInteractiveDevSession: boolean | undefined;
  rawConfig: ResolvedConfig;
  rawArgs: DevCommandOptions;
  client: CliApiClient;
  onErr?: (error: Error) => void;
  keepTmpFiles: boolean;
};

export type DevSessionInstance = {
  stop: () => void;
};

export async function startDevSession({
  rawConfig,
  name,
  rawArgs,
  client,
  dashboardUrl,
  keepTmpFiles,
}: DevSessionOptions): Promise<DevSessionInstance> {
  clearTmpDirs(rawConfig.workingDir);
  const destination = getTmpDir(rawConfig.workingDir, "build", keepTmpFiles);

  const runtime = await startWorkerRuntime({
    name,
    config: rawConfig,
    args: rawArgs,
    client,
    dashboardUrl,
  });

  const stopOutput = startDevOutput({
    name,
    dashboardUrl,
    config: rawConfig,
    args: rawArgs,
  });

  const alwaysExternal = await resolveAlwaysExternal(client);

  logger.debug("Starting dev session", {
    destination: destination.path,
    rawConfig,
    alwaysExternal,
  });

  const externalsExtension = createExternalsBuildExtension("dev", rawConfig, alwaysExternal);
  const buildContext = createBuildContext("dev", rawConfig);
  buildContext.prependExtension(externalsExtension);
  await notifyExtensionOnBuildStart(buildContext);
  const pluginsFromExtensions = resolvePluginsForContext(buildContext);

  async function updateBundle(bundle: BundleResult, workerDir?: EphemeralDirectory) {
    let buildManifest = await createBuildManifestFromBundle(
      bundle,
      destination.path,
      rawConfig,
      workerDir?.path
    );

    logger.debug("Created build manifest from bundle", { buildManifest });

    buildManifest = await notifyExtensionOnBuildComplete(buildContext, buildManifest);

    try {
      logger.debug("Updated bundle", { bundle, buildManifest });

      await runtime.initializeWorker(buildManifest, workerDir?.remove ?? (() => {}));
    } catch (error) {
      if (error instanceof Error) {
        eventBus.emit("backgroundWorkerIndexingError", buildManifest, error);
      } else {
        logger.error("Error updating bundle", { error });
      }
    }
  }

  async function updateBuild(build: esbuild.BuildResult, workerDir: EphemeralDirectory) {
    const bundle = await getBundleResultFromBuild("dev", rawConfig.workingDir, rawConfig, build);

    if (bundle) {
      await updateBundle({ ...bundle, stop: undefined }, workerDir);
    }
  }

  let bundled = false;
  const onEnd = {
    name: "on-end",
    setup(b: esbuild.PluginBuild) {
      b.onStart(() => {
        logger.debug("on-end plugin started");

        if (bundled) {
          eventBus.emit("rebuildStarted", "dev");
        }

        const outdir = b.initialOptions.outdir;
        if (outdir && existsSync(outdir)) {
          logger.debug("Removing outdir", { outdir });

          rmSync(outdir, { recursive: true, force: true });
          mkdirSync(outdir, { recursive: true });
        }
      });
      b.onEnd(async (result: esbuild.BuildResult) => {
        const errors = result.errors;
        const warnings = result.warnings;
        if (errors.length > 0) {
          logBuildFailure(errors, warnings);
          return;
        }

        if (warnings.length > 0) {
          logBuildWarnings(warnings);
        }

        if (!bundled) {
          // First bundle, no need to update bundle
          bundled = true;
        } else {
          const workerDir = getTmpDir(rawConfig.workingDir, "build", keepTmpFiles);

          await updateBuild(result, workerDir);
        }
      });
    },
  };

  async function runBundle() {
    eventBus.emit("buildStarted", "dev");

    // Use glob to find initial entryPoints
    // Use chokidar to watch for entryPoints changes (e.g. added or removed?)
    // When there is a change, update entryPoints and start a new build with watch: true
    const bundleResult = await bundleWorker({
      target: "dev",
      cwd: rawConfig.workingDir,
      destination: destination.path,
      watch: true,
      resolvedConfig: rawConfig,
      plugins: [...pluginsFromExtensions, onEnd],
      jsxFactory: rawConfig.build.jsx.factory,
      jsxFragment: rawConfig.build.jsx.fragment,
      jsxAutomatic: rawConfig.build.jsx.automatic,
    });

    await updateBundle(bundleResult);

    return bundleResult.stop;
  }

  const stopBundling = await runBundle();

  return {
    stop: () => {
      logger.debug("Stopping dev session");

      destination.remove();
      stopBundling?.().catch((error) => {});
      runtime.shutdown().catch((error) => {});
      stopOutput();
    },
  };
}

async function createBuildManifestFromBundle(
  bundle: BundleResult,
  destination: string,
  resolvedConfig: ResolvedConfig,
  workerDir: string | undefined
): Promise<BuildManifest> {
  const buildManifest: BuildManifest = {
    contentHash: bundle.contentHash,
    runtime: resolvedConfig.runtime ?? DEFAULT_RUNTIME,
    cliPackageVersion: VERSION,
    packageVersion: CORE_VERSION,
    environment: "dev",
    target: "dev",
    files: bundle.files,
    sources: await resolveFileSources(bundle.files, resolvedConfig),
    externals: [],
    config: {
      project: resolvedConfig.project,
      dirs: resolvedConfig.dirs,
    },
    outputPath: destination,
    runWorkerEntryPoint: bundle.runWorkerEntryPoint ?? devRunWorker,
    indexWorkerEntryPoint: bundle.indexWorkerEntryPoint ?? devIndexWorker,
    loaderEntryPoint: bundle.loaderEntryPoint,
    configPath: bundle.configPath,
    customConditions: resolvedConfig.build.conditions ?? [],
    deploy: {
      env: {},
    },
    build: {},
    otelImportHook: {
      include: resolvedConfig.instrumentedPackageNames ?? [],
    },
  };

  if (!workerDir) {
    return buildManifest;
  }

  return copyManifestToDir(buildManifest, destination, workerDir);
}
