import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import xdgAppPaths from "xdg-app-paths";
import { z } from "zod";
import { pathExists, readJSONFileSync } from "./fileSystem";

function getGlobalConfigFolderPath() {
  const configDir = xdgAppPaths(".trigger").config();

  return configDir;
}

//auth config file
export const UserAuthConfigSchema = z.object({
  accessToken: z.string().optional(),
  apiUrl: z.string().optional(),
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
  try {
    const authConfigFilePath = getAuthConfigFilePath();

    const json = readJSONFileSync(authConfigFilePath);
    const parsed = UserAuthConfigSchema.parse(json);
    return parsed;
  } catch (error) {
    return undefined;
  }
}
