import pathModule from "path";
import { pathExists, readFile } from "./fileSystem";
import { logger } from "./logger";
import dotenv from "dotenv";
import { CLOUD_API_URL } from "../consts";

export async function readEnvFilesWithBackups(
  path: string,
  envFile: string,
  backups: string[]
): Promise<{ content: string; fileName: string } | undefined> {
  const envFilePath = pathModule.join(path, envFile);
  const envFileExists = await pathExists(envFilePath);

  if (envFileExists) {
    const content = await readFile(envFilePath);

    return { content, fileName: envFile };
  }

  for (const backup of backups) {
    const backupPath = pathModule.join(path, backup);
    const backupExists = await pathExists(backupPath);

    if (backupExists) {
      const content = await readFile(backupPath);

      return { content, fileName: backup };
    }
  }

  return;
}

export async function getTriggerApiDetails(path: string, envFile: string) {
  const resolvedEnvFile = await readEnvFilesWithBackups(path, envFile, [
    ".env",
    ".env.local",
    ".env.development.local",
  ]);

  if (!resolvedEnvFile) {
    logger.error(`You must add TRIGGER_API_KEY to your ${envFile} file.`);
    return;
  }

  const parsedEnvFile = dotenv.parse(resolvedEnvFile.content);

  if (!parsedEnvFile) {
    logger.error(`You must add TRIGGER_API_KEY to your ${envFile} file.`);
    return;
  }

  const apiKey = parsedEnvFile.TRIGGER_API_KEY;
  const apiUrl = parsedEnvFile.TRIGGER_API_URL;

  if (!apiKey) {
    logger.error(`You must add TRIGGER_API_KEY to your ${envFile} file.`);
    return;
  }

  return { apiKey, apiUrl: apiUrl ?? CLOUD_API_URL, envFile: resolvedEnvFile.fileName };
}
