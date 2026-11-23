import { S2 } from "@s2-dev/streamstore";
import { env } from "~/env.server";
import { cliCanFollow, publicEndpoint, skipsAccessTokens } from "./deploymentLogsConfig";

/**
 * The S2 client for deployment build logs. By default it talks to s2.dev; with
 * `S2_DEPLOYMENT_LOGS_ENDPOINT` set it talks to a self-hosted S2 (for example s2-lite in local
 * development), which serves the account and basin APIs from one URL.
 */
export function createDeploymentLogsS2Client(): S2 | undefined {
  if (env.S2_ENABLED !== "1") return undefined;
  const endpoint = env.S2_DEPLOYMENT_LOGS_ENDPOINT;
  return new S2({
    accessToken: env.S2_ACCESS_TOKEN,
    ...(endpoint ? { endpoints: { account: endpoint, basin: endpoint } } : {}),
  });
}

/**
 * Self-hosted S2 without access tokens (s2-lite) can't issue scoped read tokens. The browser and
 * the CLI then read without one, and get this placeholder instead of the server's own token.
 */
export const UNAUTHENTICATED_S2_TOKEN = "unauthenticated";

export function skipDeploymentLogsAccessTokens() {
  return skipsAccessTokens(env);
}

/** Where browsers read build logs from, when it isn't s2.dev. */
export function deploymentLogsPublicEndpoint(): string | undefined {
  return publicEndpoint(env);
}

/** Whether the deploy API gives the CLI the build log stream to follow. */
export function cliCanFollowDeploymentLogs(): boolean {
  return cliCanFollow(env);
}
