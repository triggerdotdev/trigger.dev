import { App, Octokit } from "octokit";
import { env } from "../env.server";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { tryCatch } from "@trigger.dev/core/utils";
import {
  getAuthenticatedGitHubLogin,
  verifyGitHubAppInstallationAccess,
} from "./gitHubInstallationOwnership.server";

function isGitHubAppUserOAuthConfigured(): boolean {
  return (
    env.GITHUB_APP_ENABLED === "1" &&
    Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET)
  );
}

export const githubApp =
  env.GITHUB_APP_ENABLED === "1"
    ? new App({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhooks: {
          secret: env.GITHUB_APP_WEBHOOK_SECRET,
        },
        ...(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
          ? {
              oauth: {
                clientId: env.GITHUB_APP_CLIENT_ID,
                clientSecret: env.GITHUB_APP_CLIENT_SECRET,
              },
            }
          : {}),
      })
    : null;

async function withGitHubUserToken<T>(
  oauthCode: string,
  fn: (userOctokit: Octokit) => Promise<T>
): Promise<T> {
  if (!githubApp) {
    throw new Error("GitHub App is not enabled");
  }

  const { authentication } = await githubApp.oauth.createToken({ code: oauthCode });

  const [error, result] = await tryCatch(fn(new Octokit({ auth: authentication.token })));

  const [revokeError] = await tryCatch(
    githubApp.oauth.deleteToken({ token: authentication.token })
  );
  if (revokeError) {
    logger.warn("Failed to revoke GitHub user token", {
      error: revokeError instanceof Error ? revokeError.message : "Unknown error",
    });
  }

  if (error) {
    throw error;
  }

  return result;
}

/**
 * Links a GitHub App installation to a Trigger organization
 */
export async function linkGitHubAppInstallation(params: {
  installationId: number;
  organizationId: string;
  installedByUserId: string;
  oauthCode: string;
}): Promise<void> {
  if (!githubApp) {
    throw new Error("GitHub App is not enabled");
  }

  if (!isGitHubAppUserOAuthConfigured()) {
    throw new Error("GitHub App user authorization is not configured");
  }

  const installedBy = await withGitHubUserToken(params.oauthCode, async (userOctokit) => {
    await verifyGitHubAppInstallationAccess(userOctokit, params.installationId);
    return getAuthenticatedGitHubLogin(userOctokit);
  });

  const octokit = await githubApp.getInstallationOctokit(params.installationId);
  const { data: installation } = await octokit.rest.apps.getInstallation({
    installation_id: params.installationId,
  });

  const repositories = await fetchInstallationRepositories(octokit, params.installationId);

  const repositorySelection = installation.repository_selection === "all" ? "ALL" : "SELECTED";

  await prisma.githubAppInstallation.create({
    data: {
      appInstallationId: params.installationId,
      organizationId: params.organizationId,
      installedBy,
      installedByUserId: params.installedByUserId,
      targetId: installation.target_id,
      targetType: installation.target_type,
      accountHandle: installation.account
        ? "login" in installation.account
          ? installation.account.login
          : "slug" in installation.account
            ? installation.account.slug
            : "-"
        : "-",
      permissions: installation.permissions,
      repositorySelection,
      repositories: {
        create: repositories,
      },
    },
  });
}

/**
 * Updates a GitHub App installation owned by the given Trigger organization
 */
export async function updateGitHubAppInstallation(
  installationId: number,
  organizationId: string
): Promise<void> {
  if (!githubApp) {
    throw new Error("GitHub App is not enabled");
  }

  // Scope the lookup to the caller's organization so a cross-tenant
  // installation_id cannot update another org's record. Resolve ownership
  // before calling GitHub to avoid burning the victim's API rate limit.
  const existingInstallation = await prisma.githubAppInstallation.findFirst({
    where: { appInstallationId: installationId, organizationId },
  });

  if (!existingInstallation) {
    throw new Error("GitHub App installation not found");
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const { data: installation } = await octokit.rest.apps.getInstallation({
    installation_id: installationId,
  });

  const repositorySelection = installation.repository_selection === "all" ? "ALL" : "SELECTED";

  // repos are updated asynchronously via webhook events
  await prisma.githubAppInstallation.update({
    where: { id: existingInstallation?.id },
    data: {
      appInstallationId: installationId,
      targetId: installation.target_id,
      targetType: installation.target_type,
      accountHandle: installation.account
        ? "login" in installation.account
          ? installation.account.login
          : "slug" in installation.account
            ? installation.account.slug
            : "-"
        : "-",
      permissions: installation.permissions,
      suspendedAt: existingInstallation?.suspendedAt,
      repositorySelection,
    },
  });
}

async function fetchInstallationRepositories(octokit: Octokit, installationId: number) {
  const iterator = octokit.paginate.iterator(octokit.rest.apps.listReposAccessibleToInstallation, {
    installation_id: installationId,
    per_page: 100,
  });

  const allRepos = [];
  const maxPages = 3;
  let pageCount = 0;

  for await (const { data } of iterator) {
    pageCount++;
    allRepos.push(...data);

    if (maxPages && pageCount >= maxPages) {
      logger.warn("GitHub installation repository fetch truncated", {
        installationId,
        maxPages,
        totalReposFetched: allRepos.length,
      });
      break;
    }
  }

  return allRepos.map((repo) => ({
    githubId: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    private: repo.private,
    defaultBranch: repo.default_branch,
  }));
}

/**
 * Checks if a branch exists in a GitHub repository
 */
export function checkGitHubBranchExists(
  installationId: number,
  fullRepoName: string,
  branch: string
): ResultAsync<boolean, { type: "other" | "github_app_not_enabled"; cause?: unknown }> {
  if (!githubApp) {
    return errAsync({ type: "github_app_not_enabled" as const });
  }

  if (!branch || branch.trim() === "") {
    return okAsync(false);
  }

  const [owner, repo] = fullRepoName.split("/");

  const getOctokit = () =>
    fromPromise(githubApp.getInstallationOctokit(installationId), (error) => ({
      type: "other" as const,
      cause: error,
    }));

  const getBranch = (octokit: Octokit) =>
    fromPromise(
      octokit.rest.repos.getBranch({
        owner,
        repo,
        branch,
      }),
      (error) => ({
        type: "other" as const,
        cause: error,
      })
    );

  return getOctokit()
    .andThen((octokit) => getBranch(octokit))
    .map(() => true)
    .orElse((error) => {
      if (
        error.cause &&
        error.cause instanceof Error &&
        "status" in error.cause &&
        error.cause.status === 404
      ) {
        return okAsync(false);
      }

      return errAsync(error);
    });
}
