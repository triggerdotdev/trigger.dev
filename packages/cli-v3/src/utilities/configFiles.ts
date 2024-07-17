import { Config, ResolvedConfig } from "@trigger.dev/core/v3";
import { findUp } from "find-up";
import { mkdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
import xdgAppPaths from "xdg-app-paths";
import { z } from "zod";
import { CLOUD_API_URL, CONFIG_FILES } from "../consts.js";
import { createTempDir, readJSONFileSync } from "./fileSystem.js";
import { logger } from "./logger.js";
import { findTriggerDirectories, resolveTriggerDirectories } from "./taskFiles.js";
import { build } from "esbuild";
import { esbuildDecorators } from "@anatine/esbuild-decorators";

function getGlobalConfigFolderPath() {
  const configDir = xdgAppPaths("trigger").config();

  return configDir;
}

//auth config file
export const UserAuthConfigSchema = z.object({
  accessToken: z.string().optional(),
  apiUrl: z.string().optional(),
});

export type UserAuthConfig = z.infer<typeof UserAuthConfigSchema>;

const UserAuthConfigFileSchema = z.record(UserAuthConfigSchema);

type UserAuthConfigFile = z.infer<typeof UserAuthConfigFileSchema>;

function getAuthConfigFilePath() {
  return path.join(getGlobalConfigFolderPath(), "default.json");
}

export function writeAuthConfigProfile(config: UserAuthConfig, profile: string = "default") {
  const existingConfig = readAuthConfigFile() || {};

  existingConfig[profile] = config;

  writeAuthConfigFile(existingConfig);
}

export function readAuthConfigProfile(profile: string = "default"): UserAuthConfig | undefined {
  try {
    const authConfigFilePath = getAuthConfigFilePath();

    logger.debug(`Reading auth config file`, { authConfigFilePath });

    const json = readJSONFileSync(authConfigFilePath);
    const parsed = UserAuthConfigFileSchema.parse(json);
    return parsed[profile];
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    return undefined;
  }
}

export function deleteAuthConfigProfile(profile: string = "default") {
  const existingConfig = readAuthConfigFile() || {};

  delete existingConfig[profile];

  writeAuthConfigFile(existingConfig);
}

export function readAuthConfigFile(): UserAuthConfigFile | undefined {
  try {
    const authConfigFilePath = getAuthConfigFilePath();

    logger.debug(`Reading auth config file`, { authConfigFilePath });

    const json = readJSONFileSync(authConfigFilePath);
    const parsed = UserAuthConfigFileSchema.parse(json);
    return parsed;
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    return undefined;
  }
}

export function writeAuthConfigFile(config: UserAuthConfigFile) {
  const authConfigFilePath = getAuthConfigFilePath();
  mkdirSync(path.dirname(authConfigFilePath), {
    recursive: true,
  });
  writeFileSync(path.join(authConfigFilePath), JSON.stringify(config), {
    encoding: "utf-8",
  });
}

async function getConfigPath(dir: string, fileName?: string): Promise<string | undefined> {
  logger.debug("Searching for the config file", {
    dir,
    fileName,
    configFiles: CONFIG_FILES,
  });

  return await findUp(fileName ? [fileName] : CONFIG_FILES, { cwd: dir });
}

async function findFilePath(dir: string, fileName: string): Promise<string | undefined> {
  const result = await findUp([fileName], { cwd: dir });

  logger.debug("Searched for the file", {
    dir,
    fileName,
    result,
  });

  return result;
}

export type ReadConfigOptions = {
  projectRef?: string;
  configFile?: string;
  cwd?: string;
};

export type ReadConfigFileResult = {
  status: "file";
  config: ResolvedConfig;
  path: string;
  module?: any;
};

export type ReadConfigResult =
  | ReadConfigFileResult
  | {
      status: "in-memory";
      config: ResolvedConfig;
    }
  | {
      status: "error";
      error: unknown;
    };

export async function readConfig(
  dir: string,
  options?: ReadConfigOptions
): Promise<ReadConfigResult> {
  const absoluteDir = path.resolve(options?.cwd || process.cwd(), dir);

  const configPath = await getConfigPath(dir, options?.configFile);

  if (!configPath) {
    if (options?.projectRef) {
      const rawConfig = await normalizeConfig({ project: options.projectRef });
      const config = Config.parse(rawConfig);

      return {
        status: "in-memory",
        config: await resolveConfig(absoluteDir, config),
      };
    } else {
      throw new Error(`Config file not found in ${absoluteDir} or any parent directory.`);
    }
  }

  const tempDir = await createTempDir();

  const builtConfigFilePath = join(tempDir, "config.js");
  const builtConfigFileHref = pathToFileURL(builtConfigFilePath).href;

  logger.debug("Building config file", {
    configPath,
    builtConfigFileHref,
    builtConfigFilePath,
  });

  // We need to build the path to the config file, and then import it?
  await build({
    entryPoints: [configPath],
    bundle: true,
    metafile: true,
    minify: false,
    write: true,
    format: "cjs",
    platform: "node",
    target: ["es2020", "node18"],
    outfile: builtConfigFilePath,
    logLevel: "silent",
    plugins: [
      esbuildDecorators({
        cwd: absoluteDir,
        tsx: false,
        force: false,
      }),
      {
        name: "native-node-modules",
        setup(build) {
          const opts = build.initialOptions;
          opts.loader = opts.loader || {};
          opts.loader[".node"] = "copy";
        },
      },
    ],
  });

  try {
    // import the config file
    const userConfigModule = await import(builtConfigFileHref);

    // The --project-ref CLI arg will always override the project specified in the config file
    const rawConfig = await normalizeConfig(
      userConfigModule?.config,
      options?.projectRef ? { project: options?.projectRef } : undefined
    );

    const config = Config.parse(rawConfig);

    return {
      status: "file",
      config: await resolveConfig(absoluteDir, config),
      path: configPath,
      module: userConfigModule,
    };
  } catch (error) {
    return {
      status: "error",
      error,
    };
  }
}

export async function resolveConfig(path: string, config: Config): Promise<ResolvedConfig> {
  if (!config.triggerDirectories) {
    config.triggerDirectories = await findTriggerDirectories(path);
    // TODO trigger-dir-missing: throw error if no trigger directory is found
  }

  config.triggerDirectories = resolveTriggerDirectories(path, config.triggerDirectories);
  // TODO trigger-dir-not-found: throw error if trigger directories do not exist

  logger.debug("Resolved trigger directories", { triggerDirectories: config.triggerDirectories });

  if (!config.triggerUrl) {
    config.triggerUrl = CLOUD_API_URL;
  }

  if (!config.projectDir) {
    config.projectDir = path;
  }

  if (!config.tsconfigPath) {
    config.tsconfigPath = await findFilePath(path, "tsconfig.json");
  }

  if (!config.additionalFiles) {
    config.additionalFiles = [];
  }

  if (config.extraCACerts) {
    config.additionalFiles.push(config.extraCACerts);
    config.extraCACerts = config.extraCACerts.replace(/^(\.[.]?\/)+/, "");
  }

  return config as ResolvedConfig;
}

export async function normalizeConfig(config: any, overrides?: Record<string, any>): Promise<any> {
  let normalized = config;

  if (typeof config === "function") {
    normalized = await config();
  }

  normalized = { ...normalized, ...overrides };

  return normalized;
}
