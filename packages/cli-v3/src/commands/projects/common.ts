import { CliApiClient } from "../../apiClient.js";
import type { CommonCommandOptions } from "../../cli/common.js";
import { login } from "../login.js";

export async function getPatApiClient(options: CommonCommandOptions) {
  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: true,
  });

  if (!authorization.ok) {
    throw new Error(
      `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
    );
  }

  return new CliApiClient(authorization.auth.apiUrl, authorization.auth.accessToken);
}
