import { readAuthConfigFile, writeAuthConfigFile } from "../utilities/configFiles";
import { logger } from "../utilities/logger";

export async function logoutCommand(options: any) {
  const config = readAuthConfigFile();

  if (!config?.accessToken) {
    logger.info("You are already logged out");
    return;
  }

  writeAuthConfigFile({ ...config, accessToken: undefined });

  logger.info("Logged out");
}
