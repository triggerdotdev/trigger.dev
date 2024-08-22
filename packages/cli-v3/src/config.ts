import { ResolveEnvironmentVariablesFunction, TriggerConfig } from "@trigger.dev/core/v3";
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

export type ResolveConfigOptions = {
  cwd?: string;
  overrides?: Partial<TriggerConfig>;
  configFile?: string;
};

export async function loadConfig({
  cwd = process.cwd(),
}: ResolveConfigOptions = {}): Promise<ResolvedConfig> {
  const result = await c12.loadConfig<TriggerConfig>({
    name: "trigger",
    cwd,
  });

  return await resolveConfig(cwd, result);
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

async function resolveConfig(
  cwd: string,
  result: c12.ResolvedConfig<TriggerConfig>,
  overrides?: Partial<TriggerConfig>,
  warn = true
): Promise<ResolvedConfig> {
  const packageJsonPath = await resolvePackageJSON(cwd);
  const tsconfigPath = await resolveTSConfig(cwd);
  const lockfilePath = await resolveLockfile(cwd);
  const workspaceDir = await findWorkspaceDir(cwd);

  const workingDir = packageJsonPath ? dirname(packageJsonPath) : cwd;

  const config =
    "config" in result.config ? (result.config.config as TriggerConfig) : result.config;

  validateConfig(config, warn);

  let dirs = config.dirs ? config.dirs : await autoDetectDirs(workingDir);

  dirs = dirs.map((dir) => (isAbsolute(dir) ? relative(workingDir, dir) : dir));

  const mergedConfig = defu(
    {
      workingDir: packageJsonPath ? dirname(packageJsonPath) : cwd,
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
      runtime: DEFAULT_RUNTIME,
      tsconfig: tsconfigPath,
      build: {
        jsx: {
          factory: "React.createElement",
          fragment: "React.Fragment",
          automatic: true,
        },
        extensions: [],
        external: [],
      },
    }
  );

  return {
    ...mergedConfig,
    dirs: Array.from(new Set(mergedConfig.dirs)),
  };
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
        `The "additionalFiles" option is deprecated and will be removed. Use the "additionalFiles" build extension instead. See https://trigger.dev/docs/trigger-config#additionalFiles for more information.`
      );

    config.build ??= {};
    config.build.extensions ??= [];
    config.build.extensions.push(additionalFiles({ files: config.additionalFiles }));
  }

  if (config.additionalPackages && config.additionalPackages.length > 0) {
    warn &&
      prettyWarning(
        `The "additionalPackages" option is deprecated and will be removed. Use the "additionalPackages" build extension instead. See https://trigger.dev/docs/trigger-config#additionalPackages for more information.`
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
        `The "resolveEnvVars" option is deprecated and will be removed. Use the "syncEnvVars" build extension instead. See https://trigger.dev/docs/trigger-config#syncEnvVars for more information.`
      );

    const resolveEnvVarsFn = config.resolveEnvVars as ResolveEnvironmentVariablesFunction;

    config.build ??= {};
    config.build.extensions ??= [];
    config.build.extensions.push(adaptResolveEnvVarsToSyncEnvVarsExtension(resolveEnvVarsFn));
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
