import { findUp } from "find-up";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import xdgAppPaths from "xdg-app-paths";
import { z } from "zod";
import { CONFIG_FILES } from "../consts.js";
import { readJSONFileSync } from "./fileSystem.js";
import { logger } from "./logger.js";

function getGlobalConfigFolderPath() {
  const configDir = xdgAppPaths.default("trigger").config();

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
