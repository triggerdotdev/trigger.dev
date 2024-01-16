import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import xdgAppPaths from "xdg-app-paths";
import { z } from "zod";
import { isDirectory, pathExists, readJSONFileSync } from "./fileSystem";

function getGlobalConfigFolderPath() {
  const configDir = xdgAppPaths(".trigger").config();
  const legacyConfigDir = path.join(os.homedir(), ".trigger"); // Legacy config in user's home directory

  // Check for the .trigger directory in root, if it is not there then use the XDG compliant path.
  if (isDirectory(legacyConfigDir)) {
    return legacyConfigDir;
  } else {
    return configDir;
  }
}

//auth config file
export const UserAuthConfigSchema = z.object({
  accessToken: z.string().optional(),
});
export type UserAuthConfig = z.infer<typeof UserAuthConfigSchema>;

function getAuthConfigFilePath() {
  return path.join(getGlobalConfigFolderPath(), "config", "default.json");
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
  const authConfigFilePath = getAuthConfigFilePath();
  if (!pathExists(authConfigFilePath)) {
    return;
  }

  const json = readJSONFileSync(authConfigFilePath);
  const parsed = UserAuthConfigSchema.parse(json);
  return parsed;
}
