import { mkdirSync, writeFileSync } from "node:fs";
import path, { dirname } from "node:path";
import xdgAppPaths from "xdg-app-paths";
import { z } from "zod";
import { readJSONFileSync } from "./fileSystem.js";
import { logger } from "./logger.js";
import { findUp } from "find-up";
import { CLOUD_API_URL, CONFIG_FILES } from "../consts.js";
import { pathToFileURL } from "node:url";
import { Config, ResolvedConfig } from "../schemas.js";
import { findTriggerDirectories, resolveTriggerDirectories } from "./taskFiles.js";

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

function getAuthConfigFilePath() {
  return path.join(getGlobalConfigFolderPath(), "default.json");
}

export function writeAuthConfigFile(config: UserAuthConfig) {
  const authConfigFilePath = getAuthConfigFilePath();
  mkdirSync(path.dirname(authConfigFilePath), {
    recursive: true,
  });
  writeFileSync(path.join(authConfigFilePath), JSON.stringify(config), {
    encoding: "utf-8",
  });
}

export function readAuthConfigFile(): UserAuthConfig | undefined {
  try {
    const authConfigFilePath = getAuthConfigFilePath();

    const json = readJSONFileSync(authConfigFilePath);
    const parsed = UserAuthConfigSchema.parse(json);
    return parsed;
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    return undefined;
  }
}

export async function getConfigPath(dir: string): Promise<string> {
  const path = await findUp(CONFIG_FILES, { cwd: dir });

  if (!path) {
    throw new Error("No config file found.");
  }

  return path;
}

export async function readConfig(path: string): Promise<ResolvedConfig> {
  try {
    // import the config file
    const userConfigModule = await import(`${pathToFileURL(path).href}?_ts=${Date.now()}`);
    const rawConfig = await normalizeConfig(userConfigModule ? userConfigModule.default : {});
    const config = Config.parse(rawConfig);

    return resolveConfig(path, config);
  } catch (error) {
    console.error(`Failed to load config file at ${path}`);
    throw error;
  }
}

export async function resolveConfig(path: string, config: Config): Promise<ResolvedConfig> {
  if (!config.triggerDirectories) {
    config.triggerDirectories = await findTriggerDirectories(path);
  }

  config.triggerDirectories = resolveTriggerDirectories(config.triggerDirectories);

  if (!config.triggerUrl) {
    config.triggerUrl = CLOUD_API_URL;
  }

  if (!config.projectDir) {
    config.projectDir = dirname(path);
  }

  return config as ResolvedConfig;
}

export async function normalizeConfig(config: any): Promise<any> {
  if (typeof config === "function") {
    config = config();
  }

  return await config;
}
