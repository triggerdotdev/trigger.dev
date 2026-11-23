/** The settings that decide where deployment build logs are read from, as they are in the env. */
export type DeploymentLogsConfig = {
  S2_ENABLED: string;
  S2_DEPLOYMENT_LOGS_ENDPOINT?: string;
  S2_DEPLOYMENT_LOGS_PUBLIC_ENDPOINT?: string;
  S2_DEPLOYMENT_LOGS_SKIP_ACCESS_TOKENS?: string;
};

/**
 * Self-hosted S2 without access tokens (s2-lite) can't issue scoped read tokens, so build logs
 * are read without one.
 */
export function skipsAccessTokens(config: DeploymentLogsConfig): boolean {
  return config.S2_ENABLED === "1" && config.S2_DEPLOYMENT_LOGS_SKIP_ACCESS_TOKENS === "1";
}

/** Where browsers read build logs from, when it isn't s2.dev. */
export function publicEndpoint(config: DeploymentLogsConfig): string | undefined {
  if (config.S2_ENABLED !== "1") return undefined;
  return config.S2_DEPLOYMENT_LOGS_PUBLIC_ENDPOINT ?? config.S2_DEPLOYMENT_LOGS_ENDPOINT;
}

/**
 * The CLI follows a build's logs on s2.dev with the token the deploy API gives it. It can't reach
 * a self-hosted S2, and has nothing to read with when access tokens are skipped, so in both cases
 * the deploy API leaves the stream out and the CLI points at the dashboard instead of failing.
 */
export function cliCanFollow(config: DeploymentLogsConfig): boolean {
  return !publicEndpoint(config) && !skipsAccessTokens(config);
}
