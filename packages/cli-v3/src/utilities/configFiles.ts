import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const CONFIG_FILE = "config.json";
const OLD_CONFIG_FILE = "default.json";

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
  settings: z
    .object({
      hasSeenMCPInstallPrompt: z.boolean().optional(),
      hasSeenRulesInstallPrompt: z.boolean().optional(),
      lastRulesInstallPromptVersion: z.string().optional(),
    })
    .optional(),
});
type CliConfigFile = z.infer<typeof CliConfigFile>;

function getOldAuthConfigFilePath() {
  return path.join(getGlobalConfigFolderPath(), OLD_CONFIG_FILE);
}

function getAuthConfigFilePath() {
  return path.join(getGlobalConfigFolderPath(), CONFIG_FILE);
}

function getAuthConfigFileBackupPath() {
  // Multiple calls won't overwrite old backups
  return path.join(getGlobalConfigFolderPath(), `${CONFIG_FILE}.bak-${Date.now()}`);
}

function getBlankConfig(): CliConfigFile {
  return {
    version: 2,
    currentProfile: DEFFAULT_PROFILE,
    profiles: {},
    settings: {
      hasSeenMCPInstallPrompt: false,
      hasSeenRulesInstallPrompt: false,
    },
  };
}

function getConfig() {
  return readAuthConfigFile() ?? getBlankConfig();
}

export function writeAuthConfigCurrentProfileName(profile: string) {
  const config = getConfig();

  config.currentProfile = profile;

  writeAuthConfigFile(config);
}

export function readAuthConfigCurrentProfileName(): string {
  const config = getConfig();
  return config.currentProfile;
}

export function writeAuthConfigProfile(
  settings: CliConfigProfileSettings,
  profile: string = DEFFAULT_PROFILE
) {
  const config = getConfig();

  config.profiles[profile] = settings;

  writeAuthConfigFile(config);
}

export function readAuthConfigProfile(
  profile: string = DEFFAULT_PROFILE
): CliConfigProfileSettings | undefined {
  try {
    const config = getConfig();
    return config.profiles[profile];
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    return undefined;
  }
}

export function readConfigHasSeenMCPInstallPrompt(): boolean {
  const config = getConfig();
  return typeof config.settings?.hasSeenMCPInstallPrompt === "boolean"
    ? config.settings.hasSeenMCPInstallPrompt
    : false;
}

export function writeConfigHasSeenMCPInstallPrompt(hasSeenMCPInstallPrompt: boolean) {
  const config = getConfig();
  config.settings = {
    ...config.settings,
    hasSeenMCPInstallPrompt,
  };
  writeAuthConfigFile(config);
}

export function readConfigHasSeenRulesInstallPrompt(): boolean {
  const config = getConfig();
  return typeof config.settings?.hasSeenRulesInstallPrompt === "boolean"
    ? config.settings.hasSeenRulesInstallPrompt
    : false;
}

export function writeConfigHasSeenRulesInstallPrompt(hasSeenRulesInstallPrompt: boolean) {
  const config = getConfig();
  config.settings = {
    ...config.settings,
    hasSeenRulesInstallPrompt,
  };
  writeAuthConfigFile(config);
}

export function readConfigLastRulesInstallPromptVersion(): string | undefined {
  const config = getConfig();
  return config.settings?.lastRulesInstallPromptVersion;
}

export function writeConfigLastRulesInstallPromptVersion(version: string) {
  const config = getConfig();
  config.settings = {
    ...config.settings,
    lastRulesInstallPromptVersion: version,
  };
  writeAuthConfigFile(config);
}

export function deleteAuthConfigProfile(profile: string = DEFFAULT_PROFILE) {
  const config = getConfig();

  delete config.profiles[profile];

  if (config.currentProfile === profile) {
    config.currentProfile = DEFFAULT_PROFILE;
  }

  writeAuthConfigFile(config);
}

export function readAuthConfigFile(): CliConfigFile | null {
  try {
    const configFilePath = getAuthConfigFilePath();
    const configFileExists = existsSync(configFilePath);

    logger.debug(`Reading auth config file`, { configFilePath, configFileExists });

    const json = readJSONFileSync(configFileExists ? configFilePath : getOldAuthConfigFilePath());

    if ("currentProfile" in json) {
      // This is the new format
      const parsed = CliConfigFile.parse(json);
      return parsed;
    }

    // This is the old format and we need to convert it
    const oldConfigFormat = OldCliConfigFile.parse(json);

    const newConfigFormat = {
      version: 2,
      currentProfile: DEFFAULT_PROFILE,
      profiles: oldConfigFormat,
    } satisfies CliConfigFile;

    // Save to new config file location, the old file will remain untouched
    writeAuthConfigFile(newConfigFormat);

    return newConfigFormat;
  } catch (error) {
    logger.debug(`Error reading auth config file: ${error}`);
    return null;
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
