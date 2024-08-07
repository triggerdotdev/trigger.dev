import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildTarget, TaskFile } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { join, resolve } from "node:path";
import { logger } from "../utilities/logger.js";
import {
  deployEntryPoint,
  deployEntryPoints,
  devEntryPoint,
  devEntryPoints,
  isDeployEntryPoint,
  isDevEntryPoint,
  isLoaderEntryPoint,
  shims,
} from "./packageModules.js";
import { buildPlugins } from "./plugins.js";

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
  files: TaskFile[];
  configPath: string;
  loaderEntryPoint: string | undefined;
  workerEntryPoint: string | undefined;
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

  const buildOptions: esbuild.BuildOptions & { metafile: true } = {
    entryPoints,
    outdir: options.destination,
    absWorkingDir: options.cwd,
    bundle: true,
    metafile: true,
    write: true,
    minify: false,
    splitting: true,
    charset: "utf8",
    platform: "node",
    sourcemap: true,
    sourcesContent: options.target === "dev",
    conditions: ["taskhero", "node"],
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

  const bundleResult = getBundleResultFromBuild(options.target, options.cwd, result);

  if (!bundleResult) {
    throw new Error("Failed to get bundle result");
  }

  return { ...bundleResult, stop };
}

export function getBundleResultFromBuild(
  target: BuildTarget,
  workingDir: string,
  result: esbuild.BuildResult<{ metafile: true }>
): Omit<BundleResult, "stop"> | undefined {
  const files: Array<{ entry: string; out: string }> = [];

  let configPath: string | undefined;
  let loaderEntryPoint: string | undefined;
  let workerEntryPoint: string | undefined;

  for (const [outputPath, outputMeta] of Object.entries(result.metafile.outputs)) {
    if (outputPath.endsWith(".mjs")) {
      const $outputPath = resolve(workingDir, outputPath);

      if (!outputMeta.entryPoint) {
        continue;
      }

      if (isConfigEntryPoint(outputMeta.entryPoint)) {
        configPath = $outputPath;
      } else if (isLoaderEntryPoint(outputMeta.entryPoint)) {
        loaderEntryPoint = $outputPath;
      } else if (isEntryPointForTarget(outputMeta.entryPoint, target)) {
        workerEntryPoint = $outputPath;
      } else {
        files.push({
          entry: outputMeta.entryPoint,
          out: $outputPath,
        });
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
    workerEntryPoint,
  };
}

function isEntryPointForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "dev") {
    return isDevEntryPoint(entryPoint);
  } else {
    return isDeployEntryPoint(entryPoint);
  }
}

function isConfigEntryPoint(entryPoint: string) {
  return entryPoint.startsWith("trigger.config.ts");
}

async function getEntryPoints(target: BuildTarget, config: ResolvedConfig) {
  const projectEntryPoints = config.dirs.flatMap((dir) => dirToEntryPointGlob(dir));

  if (config.configFile) {
    projectEntryPoints.push(config.configFile);
  }

  if (target === "dev") {
    projectEntryPoints.push(...devEntryPoints);
  } else {
    projectEntryPoints.push(...deployEntryPoints);
  }

  return projectEntryPoints;
}

// Converts a directory to a glob that matches all the entry points in that
function dirToEntryPointGlob(dir: string): string[] {
  return [
    join(dir, "**", "*.ts"),
    join(dir, "**", "*.tsx"),
    join(dir, "**", "*.js"),
    join(dir, "**", "*.jsx"),
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
