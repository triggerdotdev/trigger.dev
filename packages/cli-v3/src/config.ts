import { TriggerConfig } from "@trigger.dev/core/v3";
import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import * as c12 from "c12";
import { defu } from "defu";
import * as esbuild from "esbuild";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { findWorkspaceDir, resolveLockfile, resolvePackageJSON, resolveTSConfig } from "pkg-types";
import { generateCode, loadFile } from "./imports/magicast.js";
import { logger } from "./utilities/logger.js";

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
    acceptHMR: async ({ oldConfig, newConfig, getDiff }) => {
      const diff = getDiff();

      logger.debug("watchConfig.acceptHMR", { diff, oldConfig, newConfig });

      if (diff.length === 0) {
        logger.debug("No config changed detected!");
        return true; // No changes!
      }

      return false;
    },
    onUpdate: async ({ newConfig, getDiff }) => {
      const diff = getDiff();

      if (diff.length === 0) {
        logger.debug("No config changed detected!");
        return;
      }

      const resolvedConfig = await resolveConfig(cwd, newConfig, overrides);

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
        const options =
          $mod.exports.default.$type === "function-call"
            ? $mod.exports.default.$args[0]
            : $mod.exports.default;

        options.build = {};

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
  overrides?: Partial<TriggerConfig>
): Promise<ResolvedConfig> {
  const packageJsonPath = await resolvePackageJSON(cwd);
  const tsconfigPath = await resolveTSConfig(cwd);
  const lockfilePath = await resolveLockfile(cwd);
  const workspaceDir = await findWorkspaceDir(cwd);

  const workingDir = packageJsonPath ? dirname(packageJsonPath) : cwd;

  let dirs = result.config.dirs ? result.config.dirs : await autoDetectDirs(workingDir);

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
    result.config,
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
