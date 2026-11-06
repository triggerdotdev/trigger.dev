import {
  getBranch,
  PrepareTrustedDeployRequest,
  PrepareTrustedDeployResponse,
  SubmitTrustedDeployRequest,
  SubmitTrustedDeployResponse,
  TRUSTED_DEPLOY_AUDIENCE,
} from "@trigger.dev/core/v3";
import { wrapZodFetch } from "@trigger.dev/core/v3/zodfetch";
import { z } from "zod";
import type { CliApiClient } from "../apiClient.js";
import type { DeployCommandOptions } from "../commands/deploy.js";
import { loadConfig } from "../config.js";
import { CLOUD_API_URL } from "../consts.js";
import { readAuthConfigProfile } from "../utilities/configFiles.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { VERSION } from "../version.js";
import { dashboardUrlForApiUrl } from "./auth.js";

type GithubActionsEnvironment = {
  GITHUB_ACTIONS?: string;
  ACTIONS_ID_TOKEN_REQUEST_URL?: string;
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
};
export type NativeBuildClient = Pick<CliApiClient, "createArtifact" | "initializeDeployment">;

export function shouldUseGithubOidc(
  authMethod: "auto" | "oidc",
  accessToken: string | undefined,
  environment: GithubActionsEnvironment = process.env
) {
  return (
    authMethod === "oidc" ||
    (!accessToken &&
      environment.GITHUB_ACTIONS === "true" &&
      !!environment.ACTIONS_ID_TOKEN_REQUEST_URL &&
      !!environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  );
}

export function validateTrustedDeployOptions(
  options: Pick<
    DeployCommandOptions,
    "localBuild" | "forceLocalBuild" | "depotBuild" | "localBundle" | "fromBundle" | "dryRun"
  >
) {
  const unsupported = [
    [options.localBuild, "--local-build"],
    [options.forceLocalBuild, "--force-local-build"],
    [options.depotBuild, "--depot-build"],
    [options.localBundle, "--local-bundle"],
    [options.fromBundle, "--from-bundle"],
    [options.dryRun, "--dry-run"],
  ].find(([enabled]) => enabled)?.[1];
  if (unsupported) {
    throw new Error(
      `${unsupported} is not supported with OIDC. Trusted deploys require a full build-server build.`
    );
  }
}

export async function runTrustedDeploy(
  projectPath: string,
  options: DeployCommandOptions,
  deploy: (args: {
    apiClient: NativeBuildClient;
    config: Awaited<ReturnType<typeof loadConfig>>;
    dashboardUrl: string;
    options: DeployCommandOptions;
    branch?: string;
  }) => Promise<void>
) {
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error(
      "GitHub OIDC is unavailable. Run in GitHub Actions with permissions: id-token: write."
    );
  }

  const envVars = resolveLocalEnvVars(options.envFile);
  if (envVars.TRIGGER_EXISTING_DEPLOYMENT_ID) {
    throw new Error("OIDC cannot attach to an existing deployment.");
  }
  const config = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef ?? envVars.TRIGGER_PROJECT_REF },
    configFile: options.config,
  });
  const gitMeta = await createGitMeta(config.workspaceDir);
  if (
    options.env === "preview" &&
    (gitMeta?.pullRequestState === "closed" || gitMeta?.pullRequestState === "merged")
  ) {
    throw new Error(
      "OIDC cannot archive Preview branches for closed or merged pull requests. No deployment was created. Run deployment jobs only for opened, synchronize, and reopened events; archive branches in the dashboard or use a separate API-key-authenticated cleanup workflow."
    );
  }
  const branch =
    options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;
  if (options.env === "preview" && !branch) {
    throw new Error("Could not determine the Preview branch. Pass --branch <branch>.");
  }

  const apiUrl =
    process.env.TRIGGER_API_URL ??
    options.apiUrl ??
    readAuthConfigProfile(options.profile)?.apiUrl ??
    CLOUD_API_URL;
  const client = createTrustedDeployClient(apiUrl, {
    projectRef: config.project,
    env: options.env,
    branch,
  });
  await deploy({
    apiClient: client,
    config,
    dashboardUrl: dashboardUrlForApiUrl(apiUrl),
    options,
    branch,
  });
}

function createTrustedDeployClient(
  apiUrl: string,
  target: Pick<PrepareTrustedDeployRequest, "projectRef" | "env" | "branch">
): NativeBuildClient {
  const baseUrl = apiUrl.replace(/\/$/, "");
  return {
    async createArtifact(body) {
      const input = PrepareTrustedDeployRequest.parse({
        ...target,
        contentLength: body.contentLength,
      });
      return wrapZodFetch(
        PrepareTrustedDeployResponse,
        `${baseUrl}/api/v1/trusted-deploys/prepare`,
        {
          method: "POST",
          headers: await githubOidcHeaders(),
          body: JSON.stringify(input),
        }
      );
    },
    async initializeDeployment(body) {
      const input = SubmitTrustedDeployRequest.parse({
        ...target,
        artifactKey: body.artifactKey,
        runtime: body.runtime,
        configFilePath: body.configFilePath,
        skipPromotion: body.skipPromotion,
        externalId: body.externalId,
        force: body.force,
      });
      // ponytail: do not retry uncertain submits until the server supports idempotency on artifactKey.
      const result = await wrapZodFetch(
        SubmitTrustedDeployResponse,
        `${baseUrl}/api/v1/trusted-deploys/submit`,
        {
          method: "POST",
          headers: await githubOidcHeaders(),
          body: JSON.stringify(input),
        },
        { retry: { maxAttempts: 1 } }
      );
      if (!result.success && (result.statusCode === undefined || result.statusCode >= 500)) {
        return {
          ...result,
          error: `${result.error} The build may already be queued. Check the dashboard before deploying again.`,
        };
      }
      return result;
    },
  };
}

async function githubOidcHeaders() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!);
  url.searchParams.set("audience", TRUSTED_DEPLOY_AUDIENCE);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `GitHub OIDC token request failed (${response.status}). Check id-token: write permissions.`
    );
  const { value } = z.object({ value: z.string().min(1) }).parse(await response.json());
  return {
    Authorization: `Bearer ${value}`,
    "Content-Type": "application/json",
    "x-trigger-cli-version": VERSION,
  };
}
