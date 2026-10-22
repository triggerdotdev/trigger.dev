export type DeployEnvironment = "prod" | "staging" | "preview";

export type DeployEnvironmentSource = "flag" | "apiKey" | "default";

const API_KEY_ENVIRONMENT_PATTERN = /^tr_(dev|stg|prod|preview)_/;

/**
 * The environment an environment API key (`tr_prod_…`, `tr_stg_…`, …) belongs to.
 * Returns undefined for personal and organization access tokens, or no token.
 */
export function environmentFromApiKey(
  accessToken: string | undefined
): DeployEnvironment | "dev" | undefined {
  const prefix = accessToken?.match(API_KEY_ENVIRONMENT_PATTERN)?.[1];

  switch (prefix) {
    case "dev":
    case "prod":
    case "preview":
      return prefix;
    case "stg":
      return "staging";
    default:
      return;
  }
}

/**
 * Picks the environment for deploy and promote. An explicit `--env` or `--prod` wins,
 * then the environment of an API key in TRIGGER_ACCESS_TOKEN, then prod.
 *
 * The server deploys to the API key's environment whatever `--env` says, so a mismatch
 * is an error rather than a deploy to an environment the user didn't ask for.
 */
export function resolveDeployEnvironment({
  env,
  prod,
  accessToken,
}: {
  env?: DeployEnvironment | "production";
  prod?: boolean;
  accessToken?: string;
}): { env: DeployEnvironment; source: DeployEnvironmentSource } {
  const flagEnv = env === "production" ? "prod" : env;

  if (prod && flagEnv && flagEnv !== "prod") {
    throw new Error(`--prod can't be combined with --env ${env}. Pass one or the other.`);
  }

  const requestedEnv = flagEnv ?? (prod ? "prod" : undefined);
  const apiKeyEnv = environmentFromApiKey(accessToken);

  if (apiKeyEnv === "dev") {
    throw new Error(
      "TRIGGER_ACCESS_TOKEN is a dev API key, which can't deploy. Use a prod, staging or preview API key, or a personal access token."
    );
  }

  if (requestedEnv) {
    if (apiKeyEnv && apiKeyEnv !== requestedEnv) {
      throw new Error(
        `TRIGGER_ACCESS_TOKEN is a ${apiKeyEnv} API key, but you asked for ${requestedEnv}. Use a ${requestedEnv} API key, or pass --env ${apiKeyEnv}.`
      );
    }

    return { env: requestedEnv, source: "flag" };
  }

  if (apiKeyEnv) {
    return { env: apiKeyEnv, source: "apiKey" };
  }

  return { env: "prod", source: "default" };
}
