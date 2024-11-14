import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { xdgAppPaths } from "../imports/xdg-app-paths.js";
import { readJSONFileSync } from "./fileSystem.js";
import { logger } from "./logger.js";

function getGlobalConfigFolderPath() {
  const configDir = xdgAppPaths("trigger").config();

  return configDir;
}

export const DEFFAULT_PROFILE = "default";

const CliConfigProfileSettings = z.object({
  accessToken: z.string().optional(),
  apiUrl: z.string().optional(),
});
type CliConfigProfileSettings = z.infer<typeof CliConfigProfileSettings>;

const OldCliConfigFile = z.record(CliConfigProfileSettings);
type OldCliConfigFile = z.infer<typeof OldCliConfigFile>;

const CliConfigFile = z.object({
  version: z.literal(2),
  currentProfile: z.string().default(DEFFAULT_PROFILE),
  profiles: z.record(CliConfigProfileSettings),
});
type CliConfigFile = z.infer<typeof CliConfigFile>;

function getAuthConfigFilePath() {
  return path.join(getGlobalConfigFolderPath(), "default.json");
}

export function writeAuthConfigCurrentProfileName(profile: string) {
  const existingConfig = readAuthConfigFile();

  existingConfig.currentProfile = profile;

  writeAuthConfigFile(existingConfig);
}

export function readAuthConfigCurrentProfileName(): string {
  const existingConfig = readAuthConfigFile();
  return existingConfig.currentProfile;
}

export function writeAuthConfigProfile(
  settings: CliConfigProfileSettings,
  profile: string = DEFFAULT_PROFILE
) {
  const existingConfig = readAuthConfigFile();

  existingConfig.profiles[profile] = settings;

  writeAuthConfigFile(existingConfig);
}

export function readAuthConfigProfile(
  profile: string = DEFFAULT_PROFILE
): CliConfigProfileSettings | undefined {
  try {
    const config = readAuthConfigFile();
    return config.profiles[profile];
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    return undefined;
  }
}

export function deleteAuthConfigProfile(profile: string = DEFFAULT_PROFILE) {
  const existingConfig = readAuthConfigFile();

  delete existingConfig.profiles[profile];

  writeAuthConfigFile(existingConfig);
}

export function readAuthConfigFile(): CliConfigFile {
  try {
    const authConfigFilePath = getAuthConfigFilePath();

    logger.debug(`Reading auth config file`, { authConfigFilePath });

    const json = readJSONFileSync(authConfigFilePath);

    if ("currentProfile" in json) {
      // This is the new format
      const parsed = CliConfigFile.parse(json);
      return parsed;
    }

    // This is the old format and we need to convert it
    const parsed = OldCliConfigFile.parse(json);

    return {
      version: 2,
      currentProfile: DEFFAULT_PROFILE,
      profiles: parsed,
    };
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    throw new Error(`Error reading auth config file: ${error}`);
  }
}

export function writeAuthConfigFile(config: CliConfigFile) {
  const authConfigFilePath = getAuthConfigFilePath();
  mkdirSync(path.dirname(authConfigFilePath), {
    recursive: true,
  });
  writeFileSync(path.join(authConfigFilePath), JSON.stringify(config, undefined, 2), {
    encoding: "utf-8",
  });
}
