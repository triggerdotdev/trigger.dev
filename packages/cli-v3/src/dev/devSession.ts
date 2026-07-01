import type { ResolvedConfig } from "@trigger.dev/core/v3/build";
import type * as esbuild from "esbuild";
import type { CliApiClient } from "../apiClient.js";
import type { BundleResult } from "../build/bundle.js";
import {
  bundleWorker,
  createBuildManifestFromBundle,
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
import { type DevCommandOptions } from "../commands/dev.js";
import { eventBus } from "../utilities/eventBus.js";
import { logger } from "../utilities/logger.js";
import type { EphemeralDirectory } from "../utilities/tempDirectories.js";
import { clearTmpDirs, getStoreDir, getTmpDir } from "../utilities/tempDirectories.js";
import { startDevOutput } from "./devOutput.js";
import { startWorkerRuntime } from "./devSupervisor.js";
import { startMcpServer, stopMcpServer } from "./mcpServer.js";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { join } from "node:path";

export type DevSessionOptions = {
  name: string | undefined;
  branch?: string;
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
  branch,
  rawArgs,
  client,
  dashboardUrl,
  keepTmpFiles,
}: DevSessionOptions): Promise<DevSessionInstance> {
  clearTmpDirs(rawConfig.workingDir, branch);
  const destination = getTmpDir(rawConfig.workingDir, "build", keepTmpFiles, branch);
  // Create shared store directory for deduplicating chunk files across rebuilds
  const storeDir = getStoreDir(rawConfig.workingDir, keepTmpFiles, branch);

  const runtime = await startWorkerRuntime({
    name,
    branch,
    config: rawConfig,
    args: rawArgs,
    client,
    dashboardUrl,
  });

  if (rawArgs.mcp) {
    await startMcpServer({
      port: rawArgs.mcpPort,
      cliApiClient: client,
      devSession: {
        dashboardUrl,
        projectRef: rawConfig.project,
      },
    });
  }

  const stopOutput = startDevOutput({
    name,
    branch,
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
    let buildManifest = await createBuildManifestFromBundle({
      bundle,
      destination: destination.path,
      resolvedConfig: rawConfig,
      workerDir: workerDir?.path,
      environment: "dev",
      target: "dev",
      storeDir,
    });

    logger.debug("Created build manifest from bundle", { buildManifest });

    await writeJSONFile(
      join(workerDir?.path ?? destination.path, "metafile.json"),
      bundle.metafile
    );

    // Skill folder copying happens after the main worker indexer runs in
    // `BackgroundWorker.initialize` — that pass already discovers skills
    // via the resource catalog and reports them on `workerManifest.skills`,
    // so we don't need a duplicate indexer here (which historically ran
    // with a bare `process.env` and silently dropped skills on projects
    // whose task files read CLI-injected vars at module top level).

    buildManifest = await notifyExtensionOnBuildComplete(buildContext, buildManifest);

    try {
      logger.debug("Updated bundle", { bundle, buildManifest });

      await runtime.initializeWorker(
        buildManifest,
        bundle.metafile,
        workerDir?.remove ?? (() => {})
      );
    } catch (error) {
      if (error instanceof Error) {
        eventBus.emit("backgroundWorkerIndexingError", buildManifest, error);
      } else {
        logger.error("Error updating bundle", { error });
      }
    }
  }

  async function updateBuild(build: esbuild.BuildResult, workerDir: EphemeralDirectory) {
    const bundle = await getBundleResultFromBuild(
      "dev",
      rawConfig.workingDir,
      rawConfig,
      build,
      storeDir
    );

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
          bundled = true;
          logger.debug("First bundle, no need to update bundle");
          return;
        }

        const workerDir = getTmpDir(rawConfig.workingDir, "build", keepTmpFiles, branch);
        await updateBuild(result, workerDir);
      });
    },
  };

  async function runBundle() {
    eventBus.emit("buildStarted", "dev");

    try {
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
        storeDir,
      });

      await updateBundle(bundleResult);

      return bundleResult.stop;
    } catch (error) {
      if (error instanceof Error) {
        eventBus.emit("buildFailed", "dev", error);
      } else {
        eventBus.emit("buildFailed", "dev", new Error(String(error)));
      }

      throw error;
    }
  }

  const stopBundling = await runBundle();

  return {
    stop: () => {
      logger.debug("Stopping dev session");

      destination.remove();
      stopBundling?.().catch((_error) => {});
      runtime.shutdown().catch((_error) => {});
      stopOutput();
      stopMcpServer();
    },
  };
}
