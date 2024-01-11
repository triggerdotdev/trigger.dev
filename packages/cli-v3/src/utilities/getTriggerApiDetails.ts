import { logger } from "./logger";
import { CLOUD_API_URL } from "../consts";
import { checkApiKeyIsDevServer } from "./getApiKeyType";
import { readEnvVariables } from "./readEnvVariables";

export async function getTriggerApiDetails(path: string, envFile: string) {
  const envVarsToRead = ["TRIGGER_API_KEY", "TRIGGER_API_URL"];
  const resolvedEnvVars = await readEnvVariables(path, envFile, envVarsToRead);

  const apiKey = resolvedEnvVars.TRIGGER_API_KEY;
  const apiUrl = resolvedEnvVars.TRIGGER_API_URL;

  if (!apiKey) {
    logger.error(
      `You must add TRIGGER_API_KEY to your ${envFile} file or set as runtime environment variable.`
    );
    return;
  }

  const result = checkApiKeyIsDevServer(apiKey.value);

  if (!result.success) {
    if (result.type) {
      logger.error(
        `Your TRIGGER_API_KEY isn't a secret dev API key, you've entered a ${result.type.environment} ${result.type.type} key`
      );
    } else {
      logger.error(
        "Your TRIGGER_API_KEY isn't a secret dev API key. It should start with tr_dev_."
      );
    }
    return;
  }

  return {
    apiKey: apiKey.value,
    apiUrl: apiUrl?.value ?? CLOUD_API_URL,
    apiKeySource:
      apiKey.source.type === "runtime" ? "process runtime" : `${apiKey.source.name} file`,
  };
}
