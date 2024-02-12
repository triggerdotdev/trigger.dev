import { readAuthConfigFile, writeAuthConfigFile } from "../utilities/configFiles.js";
import { logger } from "../utilities/logger.js";

export async function logoutCommand(options: any) {
  const config = readAuthConfigFile();

  if (!config?.accessToken) {
    logger.info("You are already logged out");
    return;
  }

  writeAuthConfigFile({ ...config, accessToken: undefined, apiUrl: undefined });

  logger.info("Logged out");
}
