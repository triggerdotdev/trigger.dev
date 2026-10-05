import { log } from "@clack/prompts";
import { CliApiClient } from "../../apiClient.js";
import type { CommonCommandOptions } from "../../cli/common.js";
import { logger } from "../../utilities/logger.js";
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

const PLAN_REQUIRED_STATUS = 402;
const ALREADY_ACTIVATED_STATUS = 409;

/**
 * Creates a project, activating the Free plan first if the organization has no plan yet.
 * If activation isn't possible (self-hosted, no billing permission), the original
 * "select a plan" error is returned so the user knows what to do.
 */
export async function createProjectWithFreePlanFallback(
  apiClient: CliApiClient,
  orgParam: string,
  name: string
) {
  const response = await apiClient.createProject(orgParam, { name });

  if (response.success || response.statusCode !== PLAN_REQUIRED_STATUS) {
    return response;
  }

  const planResponse = await apiClient.activateFreePlan(orgParam);

  if (planResponse.success) {
    log.success("Activated the Free plan");
  } else if (planResponse.statusCode !== ALREADY_ACTIVATED_STATUS) {
    logger.debug("Failed to activate the Free plan", { error: planResponse.error });
    return response;
  }

  return await apiClient.createProject(orgParam, { name });
}
