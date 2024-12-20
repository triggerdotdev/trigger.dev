import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, BuildTarget, TaskFile } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { createFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import {
  deployEntryPoints,
  devEntryPoints,
  getIndexControllerForTarget,
  getIndexWorkerForTarget,
  getRunControllerForTarget,
  getRunWorkerForTarget,
  isIndexControllerForTarget,
  isIndexWorkerForTarget,
  isLoaderEntryPoint,
  isRunControllerForTarget,
  isRunWorkerForTarget,
  shims,
  telemetryEntryPoint,
  managedEntryPoints,
  unmanagedEntryPoints,
} from "./packageModules.js";
import { buildPlugins } from "./plugins.js";
import { CORE_VERSION } from "@trigger.dev/core/v3";
import { resolveFileSources } from "../utilities/sourceFiles.js";
import { copyManifestToDir } from "./manifests.js";
import { VERSION } from "../version.js";
import { assertExhaustive } from "../utilities/assertExhaustive.js";

export interface BundleOptions {
  target: BuildTarget;
  destination: string;
  cwd: string;
  resolvedConfig: ResolvedConfig;
  jsxFactory?: string;
  jsxFragment?: string;
  jsxAutomatic?: boolean;
  watch?: boolean;
  plugins?: esbuild.Plugin[];
}

export type BundleResult = {
  contentHash: string;
  files: TaskFile[];
  configPath: string;
  loaderEntryPoint: string | undefined;
  runWorkerEntryPoint: string | undefined;
  runControllerEntryPoint: string | undefined;
  indexWorkerEntryPoint: string | undefined;
  indexControllerEntryPoint: string | undefined;
  stop: (() => Promise<void>) | undefined;
};

export async function bundleWorker(options: BundleOptions): Promise<BundleResult> {
  const { resolvedConfig } = options;

  // We need to add the package entry points here somehow
  // Then we need to get them out of the build result into the build manifest
  // taskhero/dist/esm/workers/dev.js
  // taskhero/dist/esm/telemetry/loader.js
  const entryPoints = await getEntryPoints(options.target, resolvedConfig);
  const $buildPlugins = await buildPlugins(options.target, resolvedConfig);

  let initialBuildResult: (result: esbuild.BuildResult) => void;
  const initialBuildResultPromise = new Promise<esbuild.BuildResult>(
    (resolve) => (initialBuildResult = resolve)
  );
  const buildResultPlugin: esbuild.Plugin = {
    name: "Initial build result plugin",
    setup(build) {
      build.onEnd(initialBuildResult);
    },
  };

  const customConditions = options.resolvedConfig.build?.conditions ?? [];

  const conditions = [...customConditions, "trigger.dev", "module", "node"];

  const buildOptions: esbuild.BuildOptions & { metafile: true } = {
    entryPoints,
    outdir: options.destination,
    absWorkingDir: options.cwd,
    bundle: true,
    metafile: true,
    write: false,
    minify: false,
    splitting: true,
    charset: "utf8",
    platform: "node",
    sourcemap: true,
    sourcesContent: options.target === "dev",
    conditions,
    format: "esm",
    target: ["node20", "es2022"],
    loader: {
      ".js": "jsx",
      ".mjs": "jsx",
      ".cjs": "jsx",
      ".wasm": "copy",
    },
    outExtension: { ".js": ".mjs" },
    inject: [...shims], // TODO: copy this into the working dir to work with Yarn PnP
    jsx: options.jsxAutomatic ? "automatic" : undefined,
    jsxDev: options.jsxAutomatic && options.target === "dev" ? true : undefined,
    plugins: [...$buildPlugins, ...(options.plugins ?? []), buildResultPlugin],
    ...(options.jsxFactory && { jsxFactory: options.jsxFactory }),
    ...(options.jsxFragment && { jsxFragment: options.jsxFragment }),
    logLevel: "silent",
    logOverride: {
      "empty-glob": "silent",
    },
  };

  let result: esbuild.BuildResult<typeof buildOptions>;
  let stop: BundleResult["stop"];

  logger.debug("Building worker with options", buildOptions);

  if (options.watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    result = await initialBuildResultPromise;
    if (result.errors.length > 0) {
      throw new Error("Failed to build");
    }

    stop = async function () {
      await ctx.dispose();
    };
  } else {
    result = await esbuild.build(buildOptions);
    // Even when we're not watching, we still want some way of cleaning up the
    // temporary directory when we don't need it anymore
    stop = async function () {};
  }

  const bundleResult = await getBundleResultFromBuild(
    options.target,
    options.cwd,
    options.resolvedConfig,
    result
  );

  if (!bundleResult) {
    throw new Error("Failed to get bundle result");
  }

  return { ...bundleResult, stop };
}

export async function getBundleResultFromBuild(
  target: BuildTarget,
  workingDir: string,
  resolvedConfig: ResolvedConfig,
  result: esbuild.BuildResult<{ metafile: true; write: false }>
): Promise<Omit<BundleResult, "stop"> | undefined> {
  const hasher = createHash("md5");

  for (const outputFile of result.outputFiles) {
    hasher.update(outputFile.hash);

    await createFile(outputFile.path, outputFile.contents);
  }

  const files: Array<{ entry: string; out: string }> = [];

  let configPath: string | undefined;
  let loaderEntryPoint: string | undefined;
  let runWorkerEntryPoint: string | undefined;
  let runControllerEntryPoint: string | undefined;
  let indexWorkerEntryPoint: string | undefined;
  let indexControllerEntryPoint: string | undefined;

  const configEntryPoint = resolvedConfig.configFile
    ? relative(resolvedConfig.workingDir, resolvedConfig.configFile)
    : "trigger.config.ts";

  for (const [outputPath, outputMeta] of Object.entries(result.metafile.outputs)) {
    if (outputPath.endsWith(".mjs")) {
      const $outputPath = resolve(workingDir, outputPath);

      if (!outputMeta.entryPoint) {
        continue;
      }

      if (outputMeta.entryPoint.startsWith(configEntryPoint)) {
        configPath = $outputPath;
      } else if (isLoaderEntryPoint(outputMeta.entryPoint)) {
        loaderEntryPoint = $outputPath;
      } else if (isRunControllerForTarget(outputMeta.entryPoint, target)) {
        runControllerEntryPoint = $outputPath;
      } else if (isRunWorkerForTarget(outputMeta.entryPoint, target)) {
        runWorkerEntryPoint = $outputPath;
      } else if (isIndexControllerForTarget(outputMeta.entryPoint, target)) {
        indexControllerEntryPoint = $outputPath;
      } else if (isIndexWorkerForTarget(outputMeta.entryPoint, target)) {
        indexWorkerEntryPoint = $outputPath;
      } else {
        if (
          !outputMeta.entryPoint.startsWith("..") &&
          !outputMeta.entryPoint.includes("node_modules")
        ) {
          files.push({
            entry: outputMeta.entryPoint,
            out: $outputPath,
          });
        }
      }
    }
  }

  if (!configPath) {
    return undefined;
  }

  return {
    files,
    configPath: configPath,
    loaderEntryPoint,
    runWorkerEntryPoint,
    runControllerEntryPoint,
    indexWorkerEntryPoint,
    indexControllerEntryPoint,
    contentHash: hasher.digest("hex"),
  };
}

async function getEntryPoints(target: BuildTarget, config: ResolvedConfig) {
  const projectEntryPoints = config.dirs.flatMap((dir) => dirToEntryPointGlob(dir));

  if (config.configFile) {
    projectEntryPoints.push(config.configFile);
  }

  switch (target) {
    case "dev": {
      projectEntryPoints.push(...devEntryPoints);
      break;
    }
    case "deploy": {
      projectEntryPoints.push(...deployEntryPoints);
      break;
    }
    case "managed": {
      projectEntryPoints.push(...managedEntryPoints);
      break;
    }
    case "unmanaged": {
      projectEntryPoints.push(...unmanagedEntryPoints);
      break;
    }
    default: {
      assertExhaustive(target);
    }
  }

  if (config.instrumentedPackageNames?.length ?? 0 > 0) {
    projectEntryPoints.push(telemetryEntryPoint);
  }

  return projectEntryPoints;
}

// Converts a directory to a glob that matches all the entry points in that
function dirToEntryPointGlob(dir: string): string[] {
  return [
    join(dir, "**", "*.ts"),
    join(dir, "**", "*.tsx"),
    join(dir, "**", "*.mts"),
    join(dir, "**", "*.cts"),
    join(dir, "**", "*.js"),
    join(dir, "**", "*.jsx"),
    join(dir, "**", "*.mjs"),
    join(dir, "**", "*.cjs"),
  ];
}

export function logBuildWarnings(warnings: esbuild.Message[]) {
  const logs = esbuild.formatMessagesSync(warnings, { kind: "warning", color: true });
  for (const log of logs) {
    console.warn(log);
  }
}

/**
 * Logs all errors/warnings associated with an esbuild BuildFailure in the same
 * style esbuild would.
 */
export function logBuildFailure(errors: esbuild.Message[], warnings: esbuild.Message[]) {
  const logs = esbuild.formatMessagesSync(errors, { kind: "error", color: true });
  for (const log of logs) {
    console.error(log);
  }
  logBuildWarnings(warnings);
}

export async function createBuildManifestFromBundle({
  bundle,
  destination,
  resolvedConfig,
  workerDir,
  environment,
  target,
  envVars,
  sdkVersion,
}: {
  bundle: BundleResult;
  destination: string;
  resolvedConfig: ResolvedConfig;
  workerDir?: string;
  environment: string;
  target: BuildTarget;
  envVars?: Record<string, string>;
  sdkVersion?: string;
}): Promise<BuildManifest> {
  const buildManifest: BuildManifest = {
    contentHash: bundle.contentHash,
    runtime: resolvedConfig.runtime ?? DEFAULT_RUNTIME,
    environment: environment,
    packageVersion: sdkVersion ?? CORE_VERSION,
    cliPackageVersion: VERSION,
    target: target,
    files: bundle.files,
    sources: await resolveFileSources(bundle.files, resolvedConfig),
    externals: [],
    config: {
      project: resolvedConfig.project,
      dirs: resolvedConfig.dirs,
    },
    outputPath: destination,
    indexControllerEntryPoint:
      bundle.indexControllerEntryPoint ?? getIndexControllerForTarget(target),
    indexWorkerEntryPoint: bundle.indexWorkerEntryPoint ?? getIndexWorkerForTarget(target),
    runControllerEntryPoint: bundle.runControllerEntryPoint ?? getRunControllerForTarget(target),
    runWorkerEntryPoint: bundle.runWorkerEntryPoint ?? getRunWorkerForTarget(target),
    loaderEntryPoint: bundle.loaderEntryPoint,
    configPath: bundle.configPath,
    customConditions: resolvedConfig.build.conditions ?? [],
    deploy: {
      env: envVars ?? {},
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
