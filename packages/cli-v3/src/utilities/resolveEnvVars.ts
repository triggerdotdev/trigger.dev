import { logger } from "./logger.js";

export async function callResolveEnvVars(
  configModule: any,
  env: Record<string, string | undefined>,
  environment: string,
  projectRef: string
): Promise<{ variables: Record<string, string>; override: boolean } | undefined> {
  if (
    configModule &&
    configModule.resolveEnvVars &&
    typeof configModule.resolveEnvVars === "function"
  ) {
    let resolvedEnvVars: Record<string, string> = {};

    try {
      let result = await configModule.resolveEnvVars({
        projectRef,
        environment,
        env,
      });

      if (!result) {
        return;
      }

      result = await result;

      if (typeof result === "object" && result !== null && "variables" in result) {
        const variables = result.variables;

        if (Array.isArray(variables)) {
          for (const item of variables) {
            if (
              typeof item === "object" &&
              item !== null &&
              "name" in item &&
              "value" in item &&
              typeof item.name === "string" &&
              typeof item.value === "string"
            ) {
              resolvedEnvVars[item.name] = item.value;
            }
          }
        } else if (typeof variables === "object") {
          for (const [key, value] of Object.entries(variables)) {
            if (typeof key === "string" && typeof value === "string") {
              resolvedEnvVars[key] = value;
            }
          }
        }
      }

      return {
        variables: resolvedEnvVars,
        override: result.override,
      };
    } catch (error) {
      logger.error(error);
    }
  }

  return;
}
