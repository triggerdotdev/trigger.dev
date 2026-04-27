import {
  BuildRuntime,
  CompatibilityFlag,
  CompatibilityFlagFeatures,
  ResolveEnvironmentVariablesFunction,
  TriggerConfig,
} from "@trigger.dev/core/v3";
import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import * as c12 from "c12";
import { defu } from "defu";
import * as esbuild from "esbuild";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { findWorkspaceDir, resolveLockfile, resolvePackageJSON, resolveTSConfig } from "pkg-types";
import { generateCode, loadFile } from "./imports/magicast.js";
import { logger } from "./utilities/logger.js";
import {
  additionalFiles,
  additionalPackages,
  syncEnvVars,
} from "@trigger.dev/build/extensions/core";
import { prettyWarning } from "./utilities/cliOutput.js";
import type { InstrumentationModuleDefinition } from "@opentelemetry/instrumentation";
import { builtinModules } from "node:module";
import { OutroCommandError } from "./cli/common.js";

export type ResolveConfigOptions = {
  cwd?: string;
  overrides?: Partial<TriggerConfig>;
  configFile?: string;
  warn?: boolean;
};

export async function loadConfig({
  cwd = process.cwd(),
  overrides,
  configFile,
  warn = true,
}: ResolveConfigOptions = {}): Promise<ResolvedConfig> {
  const result = await c12.loadConfig<TriggerConfig>({
    name: "trigger",
    cwd,
    configFile,
    jitiOptions: { debug: logger.loggerLevel === "debug" },
  });

  return await resolveConfig(cwd, result, overrides, warn);
}

type ResolveWatchConfigOptions = ResolveConfigOptions & {
  onUpdate: (config: ResolvedConfig) => void;
  debounce?: number;
  ignoreInitial?: boolean;
};

type ResolveWatchConfigResult = {
  config: ResolvedConfig;
  files: string[];
  stop: () => Promise<void>;
};

export async function watchConfig({
  cwd = process.cwd(),
  onUpdate,
  debounce = 100,
  ignoreInitial = true,
  overrides,
  configFile,
}: ResolveWatchConfigOptions): Promise<ResolveWatchConfigResult> {
  const result = await c12.watchConfig<TriggerConfig>({
    name: "trigger",
    configFile,
    cwd,
    debounce,
    chokidarOptions: { ignoreInitial },
    jitiOptions: { debug: logger.loggerLevel === "debug" },
    onUpdate: async ({ newConfig }) => {
      const resolvedConfig = await resolveConfig(cwd, newConfig, overrides, false);

      onUpdate(resolvedConfig);
    },
  });

  const config = await resolveConfig(cwd, result, overrides);

  return {
    config,
    files: result.watchingFiles,
    stop: result.unwatch,
  };
}

export function configPlugin(resolvedConfig: ResolvedConfig): esbuild.Plugin | undefined {
  const configFile = resolvedConfig.configFile;

  if (!configFile) {
    return;
  }

  // We need to strip the "build" key from the config file, so build dependencies don't make it into the final bundle
  return {
    name: "trigger-config-strip",
    setup(build) {
      const filename = basename(configFile);
      // Convert the filename to a regex to filter against
      const filter = new RegExp(`${filename.replace(/\./g, "\\.")}$`);

      logger.debug("trigger-config-strip.filter", filter);

      build.onLoad({ filter }, async (args) => {
        logger.debug("trigger-config-strip.onLoad", args);

        const $mod = await loadFile(args.path);

        // Support for both bare object export and `defineConfig` wrapper
        const options = $mod.exports.default
          ? $mod.exports.default.$type === "function-call"
            ? $mod.exports.default.$args[0]
            : $mod.exports.default
          : $mod.exports.config?.$type === "function-call"
          ? $mod.exports.config.$args[0]
          : $mod.exports.config;

        options.build = {};

        // Remove export resolveEnvVars function as well
        $mod.exports.resolveEnvVars = undefined;

        const contents = generateCode($mod);

        logger.debug("trigger-config-strip.onLoad.contents", contents);

        return {
          contents: contents.code,
          loader: "ts",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

function featuresFromCompatibilityFlags(flags: CompatibilityFlag[]): CompatibilityFlagFeatures {
  return {
    run_engine_v2: flags.includes("run_engine_v2"),
  };
}

async function resolveConfig(
  cwd: string,
  result: c12.ResolvedConfig<TriggerConfig>,
  overrides?: Partial<TriggerConfig>,
  warn = true
): Promise<ResolvedConfig> {
  const packageJsonPath = await resolvePackageJSON(cwd);
  const tsconfigPath = await safeResolveTsConfig(cwd);
  const lockfilePath = await resolveLockfile(cwd);
  const workspaceDir = await findWorkspaceDir(cwd);

  const workingDir = result.configFile
    ? dirname(result.configFile)
    : packageJsonPath
    ? dirname(packageJsonPath)
    : cwd;

  // `trigger.config` is the fallback value set by c12
  const missingConfigFile = !result.configFile || result.configFile === "trigger.config";

  if (missingConfigFile) {
    throw new OutroCommandError(
      [
        "Couldn't find your trigger.config.ts file.",
        "",
        "Make sure you are in the directory of your Trigger.dev project, or specify the path to your config file using the `--config <path>` flag.",
        "",
        "Alternatively, you can initialize a new project using `npx trigger.dev@latest init`.",
      ].join("\n")
    );
  }

  const config =
    "config" in result.config ? (result.config.config as TriggerConfig) : result.config;

  validateConfig(config, warn);

  let dirs = config.dirs ? config.dirs : await autoDetectDirs(workingDir);

  dirs = dirs.map((dir) => resolveTriggerDir(dir, workingDir));

  const features = featuresFromCompatibilityFlags(
    ["run_engine_v2" as const].concat(config.compatibilityFlags ?? [])
  );

  const defaultRuntime: BuildRuntime = features.run_engine_v2 ? "node" : DEFAULT_RUNTIME;

  const mergedConfig = defu(
    {
      workingDir,
      configFile: result.configFile,
      packageJsonPath,
      tsconfigPath,
      lockfilePath,
      workspaceDir,
    },
    overrides,
    config,
    {
      dirs,
      runtime: defaultRuntime,
      tsconfig: tsconfigPath,
      build: {
        jsx: {
          factory: "React.createElement",
          fragment: "React.Fragment",
          automatic: true,
        },
        extensions: [],
        external: [],
        conditions: [],
      },
      compatibilityFlags: [],
      features,
    }
  ) as ResolvedConfig; // TODO: For some reason, without this, there is a weird type error complaining about tsconfigPath being string | nullish, which can't be assigned to string | undefined

  return {
    ...mergedConfig,
    dirs: Array.from(new Set(dirs)),
    instrumentedPackageNames: getInstrumentedPackageNames(mergedConfig),
    runtime: mergedConfig.runtime,
  };
}

function resolveTriggerDir(dir: string, workingDir: string): string {
  if (isAbsolute(dir)) {
    // If dir is `/trigger` or `/src/trigger`, we should add a `.` to make it relative to the working directory
    if (dir === "/trigger" || dir === "/src/trigger") {
      return `.${dir}`;
    } else {
      return relative(workingDir, dir);
    }
  }

  return dir;
}

async function safeResolveTsConfig(cwd: string) {
  try {
    return await resolveTSConfig(cwd);
  } catch {
    return undefined;
  }
}

const IGNORED_DIRS = ["node_modules", ".git", "dist", "out", "build"];

async function autoDetectDirs(workingDir: string): Promise<string[]> {
  const entries = await readdir(workingDir, { withFileTypes: true });

  const dirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.includes(entry.name) || entry.name.startsWith("."))
      continue;

    const fullPath = join(workingDir, entry.name);

    // Ignore the directory if it's <any>/app/api/trigger
    if (fullPath.endsWith("app/api/trigger")) {
      continue;
    }

    if (entry.name === "trigger") {
      dirs.push(fullPath);
    }

    dirs.push(...(await autoDetectDirs(fullPath)));
  }

  return dirs;
}

function validateConfig(config: TriggerConfig, warn = true) {
  if (config.additionalFiles && config.additionalFiles.length > 0) {
    warn &&
      prettyWarning(
        `The "additionalFiles" option is deprecated and will be removed. Use the "additionalFiles" build extension instead. See https://trigger.dev/docs/config/config-file#additionalfiles for more information.`
      );

    config.build ??= {};
    config.build.extensions ??= [];
    config.build.extensions.push(additionalFiles({ files: config.additionalFiles }));
  }

  if (config.additionalPackages && config.additionalPackages.length > 0) {
    warn &&
      prettyWarning(
        `The "additionalPackages" option is deprecated and will be removed. Use the "additionalPackages" build extension instead. See https://trigger.dev/docs/config/config-file#additionalpackages for more information.`
      );

    config.build ??= {};
    config.build.extensions ??= [];
    config.build.extensions.push(additionalPackages({ packages: config.additionalPackages }));
  }

  if (config.triggerDirectories) {
    warn &&
      prettyWarning(
        `The "triggerDirectories" option is deprecated and will be removed. Use the "dirs" option instead.`
      );

    config.dirs = config.triggerDirectories;
  }

  if (config.dependenciesToBundle) {
    warn &&
      prettyWarning(
        `The "dependenciesToBundle" option is deprecated and will be removed. Dependencies are now bundled by default. If you want to exclude some dependencies from the bundle, use the "build.external" option.`
      );
  }

  if (config.tsconfigPath) {
    warn &&
      prettyWarning(
        `The "tsconfigPath" option is deprecated and will be removed. Use the "tsconfig" option instead.`
      );

    config.tsconfig = config.tsconfigPath;
  }

  if ("resolveEnvVars" in config && typeof config.resolveEnvVars === "function") {
    warn &&
      prettyWarning(
        `The "resolveEnvVars" option is deprecated and will be removed. Use the "syncEnvVars" build extension instead. See https://trigger.dev/docs/config/config-file#syncenvvars for more information.`
      );

    const resolveEnvVarsFn = config.resolveEnvVars as ResolveEnvironmentVariablesFunction;

    config.build ??= {};
    config.build.extensions ??= [];
    config.build.extensions.push(adaptResolveEnvVarsToSyncEnvVarsExtension(resolveEnvVarsFn));
  }

  if (!config.maxDuration) {
    throw new Error(
      `The "maxDuration" trigger.config option is now required, and must be at least 5 seconds.`
    );
  }

  if (config.runtime && config.runtime === "bun") {
    warn &&
      prettyWarning(
        `The "bun" runtime is currently experimental, and certain features may not work, especially opentelemetry instrumentation of 3rd party packages.`
      );
  }
}

function adaptResolveEnvVarsToSyncEnvVarsExtension(
  resolveEnvVarsFn: ResolveEnvironmentVariablesFunction
) {
  return syncEnvVars(
    async (ctx) => {
      const resolveEnvVarsResult = await resolveEnvVarsFn(ctx);

      if (!resolveEnvVarsResult) {
        return;
      }

      return resolveEnvVarsResult.variables;
    },
    { override: true }
  );
}

function getInstrumentedPackageNames(config: ResolvedConfig): Array<string> {
  const packageNames = [];

  if (config.instrumentations ?? config.telemetry?.instrumentations) {
    for (const instrumentation of config.telemetry?.instrumentations ??
      config.instrumentations ??
      []) {
      const moduleDefinitions = (
        instrumentation as any
      ).getModuleDefinitions?.() as Array<InstrumentationModuleDefinition>;

      if (!Array.isArray(moduleDefinitions)) {
        continue;
      }

      for (const moduleDefinition of moduleDefinitions) {
        if (!builtinModules.includes(moduleDefinition.name)) {
          packageNames.push(moduleDefinition.name);
        }
      }
    }
  }

  return packageNames;
}
