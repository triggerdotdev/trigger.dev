import { CORE_VERSION } from "@trigger.dev/core/v3";
import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, BuildTarget, TaskFile } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import path, { join, relative, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import { resolveFileSources } from "../utilities/sourceFiles.js";
import { VERSION } from "../version.js";
import { createEntryPointManager } from "./entryPoints.js";
import { copyManifestToDir } from "./manifests.js";
import {
  getIndexControllerForTarget,
  getIndexWorkerForTarget,
  getRunControllerForTarget,
  getRunWorkerForTarget,
  isIndexControllerForTarget,
  isIndexWorkerForTarget,
  isInitEntryPoint,
  isLoaderEntryPoint,
  isRunControllerForTarget,
  isRunWorkerForTarget,
  shims,
} from "./packageModules.js";
import { buildPlugins } from "./plugins.js";
import { cliLink, prettyError } from "../utilities/cliOutput.js";
import { SkipLoggingError } from "../cli/common.js";
import { bundlePython, createBuildManifestFromPythonBundle } from "./pythonBundler.js";

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
  metafile: esbuild.Metafile;
  loaderEntryPoint: string | undefined;
  runWorkerEntryPoint: string | undefined;
  runControllerEntryPoint: string | undefined;
  indexWorkerEntryPoint: string | undefined;
  indexControllerEntryPoint: string | undefined;
  initEntryPoint: string | undefined;
  stop: (() => Promise<void>) | undefined;
};

export class BundleError extends Error {
  constructor(
    message: string,
    public readonly issues?: esbuild.Message[]
  ) {
    super(message);
  }
}

export async function bundleWorker(options: BundleOptions): Promise<BundleResult> {
  const { resolvedConfig } = options;

  // Handle Python runtime
  if (resolvedConfig.runtime === "python") {
    return bundlePythonWorker(options);
  }

  let currentContext: esbuild.BuildContext | undefined;

  const entryPointManager = await createEntryPointManager(
    resolvedConfig.dirs,
    resolvedConfig,
    options.target,
    typeof options.watch === "boolean" ? options.watch : false,
    async (newEntryPoints) => {
      if (currentContext) {
        // Rebuild with new entry points
        await currentContext.cancel();
        await currentContext.dispose();
        const buildOptions = await createBuildOptions({
          ...options,
          entryPoints: newEntryPoints,
        });

        logger.debug("Rebuilding worker with options", buildOptions);

        currentContext = await esbuild.context(buildOptions);
        await currentContext.watch();
      }
    }
  );

  if (entryPointManager.entryPoints.length === 0) {
    const errorMessageBody = `
      Dirs config:
      ${resolvedConfig.dirs.join("\n- ")}

      Search patterns:
      ${entryPointManager.patterns.join("\n- ")}

      Possible solutions:
      1. Check if the directory paths in your config are correct
      2. Verify that your files match the search patterns
      3. Update the search patterns in your config
    `.replace(/^ {6}/gm, "");

    prettyError(
      "No trigger files found",
      errorMessageBody,
      cliLink("View the config docs", "https://trigger.dev/docs/config/config-file")
    );

    throw new SkipLoggingError();
  }

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

  const buildOptions = await createBuildOptions({
    ...options,
    entryPoints: entryPointManager.entryPoints,
    buildResultPlugin,
  });

  let result: esbuild.BuildResult<typeof buildOptions>;
  let stop: BundleResult["stop"];

  logger.debug("Building worker with options", buildOptions);

  if (options.watch) {
    currentContext = await esbuild.context(buildOptions);
    await currentContext.watch();
    result = await initialBuildResultPromise;
    if (result.errors.length > 0) {
      throw new BundleError("Failed to build", result.errors);
    }

    stop = async function () {
      await entryPointManager.stop();
      await currentContext?.dispose();
    };
  } else {
    result = await esbuild.build(buildOptions);

    stop = async function () {
      await entryPointManager.stop();
    };
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

// Helper function to create build options
async function createBuildOptions(
  options: BundleOptions & { entryPoints: string[]; buildResultPlugin?: esbuild.Plugin }
): Promise<esbuild.BuildOptions & { metafile: true }> {
  const customConditions = options.resolvedConfig.build?.conditions ?? [];
  const conditions = [...customConditions, "trigger.dev", "module", "node"];

  const keepNames =
    options.resolvedConfig.build?.keepNames ??
    options.resolvedConfig.build?.experimental_keepNames ??
    true;
  const minify =
    options.resolvedConfig.build?.minify ??
    options.resolvedConfig.build?.experimental_minify ??
    false;

  const $buildPlugins = await buildPlugins(options.target, options.resolvedConfig);

  return {
    entryPoints: options.entryPoints,
    outdir: options.destination,
    absWorkingDir: options.cwd,
    bundle: true,
    metafile: true,
    write: false,
    minify,
    splitting: true,
    charset: "utf8",
    platform: "node",
    sourcemap: true,
    sourcesContent: options.target === "dev",
    conditions,
    keepNames,
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
    plugins: [
      ...$buildPlugins,
      ...(options.plugins ?? []),
      ...(options.buildResultPlugin ? [options.buildResultPlugin] : []),
    ],
    ...(options.jsxFactory && { jsxFactory: options.jsxFactory }),
    ...(options.jsxFragment && { jsxFragment: options.jsxFragment }),
    logLevel: "silent",
    logOverride: {
      "empty-glob": "silent",
      "package.json": "silent",
    },
  };
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
  let initEntryPoint: string | undefined;

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
      } else if (isInitEntryPoint(outputMeta.entryPoint, resolvedConfig.dirs)) {
        initEntryPoint = $outputPath;
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
    initEntryPoint,
    contentHash: hasher.digest("hex"),
    metafile: result.metafile,
  };
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
  branch,
  target,
  envVars,
  sdkVersion,
}: {
  bundle: BundleResult;
  destination: string;
  resolvedConfig: ResolvedConfig;
  workerDir?: string;
  environment: string;
  branch?: string;
  target: BuildTarget;
  envVars?: Record<string, string>;
  sdkVersion?: string;
}): Promise<BuildManifest> {
  const buildManifest: BuildManifest = {
    contentHash: bundle.contentHash,
    runtime: resolvedConfig.runtime ?? DEFAULT_RUNTIME,
    environment: environment,
    branch,
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
    initEntryPoint: bundle.initEntryPoint,
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

/**
 * Bundle Python worker - entry point for Python runtime.
 * This is the Python equivalent of bundleWorker for Node.js.
 */
async function bundlePythonWorker(options: BundleOptions): Promise<BundleResult> {
  const { resolvedConfig, destination, cwd, target } = options;

  const entryPointManager = await createEntryPointManager(
    resolvedConfig.dirs,
    resolvedConfig,
    options.target,
    typeof options.watch === "boolean" ? options.watch : false,
    async (newEntryPoints) => {
      // TODO: Implement proper watch mode for Python (file copying + manifest regeneration)
      logger.debug("Python entry points changed, rebuilding");
    }
  );

  if (entryPointManager.entryPoints.length === 0) {
    const errorMessageBody = `
      Dirs config:
      ${resolvedConfig.dirs.join("\n- ")}

      Search patterns:
      ${entryPointManager.patterns.join("\n- ")}

      Possible solutions:
      1. Check if the directory paths in your config are correct
      2. Verify that your files match the search patterns
      3. Update your trigger.config.ts runtime to "python"
    `.replace(/^ {6}/gm, "");

    prettyError(
      "No Python task files found",
      errorMessageBody,
      cliLink("View the config docs", "https://trigger.dev/docs/config/config-file")
    );

    throw new SkipLoggingError();
  }

  // Bundle Python files
  logger.debug("Starting Python bundle", {
    entryPoints: entryPointManager.entryPoints.length,
  });

  const bundleResult = await bundlePython({
    entryPoints: entryPointManager.entryPoints,
    outputDir: destination,
    projectDir: cwd,
    requirementsFile: process.env.TRIGGER_REQUIREMENTS_FILE,
    config: resolvedConfig,
    target,
  });

  // Create complete BuildManifest
  const buildManifest = await createBuildManifestFromPythonBundle(bundleResult, {
    outputDir: destination,
    config: resolvedConfig,
    target,
  });

  // Write manifest to output
  const manifestPath = join(destination, "build-manifest.json");
  await writeFile(manifestPath, JSON.stringify(buildManifest, null, 2));

  // Convert to BundleResult
  const pythonBundleResult: BundleResult = {
    contentHash: buildManifest.contentHash,
    files: buildManifest.files,
    configPath: buildManifest.configPath,
    metafile: {} as esbuild.Metafile, // Empty for Python
    loaderEntryPoint: undefined,
    runWorkerEntryPoint: buildManifest.runWorkerEntryPoint,
    runControllerEntryPoint: undefined,
    indexWorkerEntryPoint: buildManifest.indexWorkerEntryPoint,
    indexControllerEntryPoint: undefined,
    initEntryPoint: undefined,
    stop: async () => {
      await entryPointManager.stop();
    },
  };

  return pythonBundleResult;
}
