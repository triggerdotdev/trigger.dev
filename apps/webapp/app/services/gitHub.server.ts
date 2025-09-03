import { App, type Octokit } from "octokit";
import { env } from "../env.server";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { tryCatch } from "@trigger.dev/core/utils";

export const githubApp =
  env.GITHUB_APP_ENABLED === "1"
    ? new App({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhooks: {
          secret: env.GITHUB_APP_WEBHOOK_SECRET,
        },
      })
    : null;

/**
 * Links a GitHub App installation to a Trigger organization
 */
export async function linkGitHubAppInstallation(
  installationId: number,
  organizationId: string
): Promise<void> {
  if (!githubApp) {
    throw new Error("GitHub App is not enabled");
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const { data: installation } = await octokit.rest.apps.getInstallation({
    installation_id: installationId,
  });

  const repositories = await fetchInstallationRepositories(octokit, installationId);

  const repositorySelection = installation.repository_selection === "all" ? "ALL" : "SELECTED";

  await prisma.githubAppInstallation.create({
    data: {
      appInstallationId: installationId,
      organizationId,
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
 * Links a GitHub App installation to a Trigger organization
 */
export async function updateGitHubAppInstallation(installationId: number): Promise<void> {
  if (!githubApp) {
    throw new Error("GitHub App is not enabled");
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const { data: installation } = await octokit.rest.apps.getInstallation({
    installation_id: installationId,
  });

  const existingInstallation = await prisma.githubAppInstallation.findFirst({
    where: { appInstallationId: installationId },
  });

  if (!existingInstallation) {
    throw new Error("GitHub App installation not found");
  }

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
export async function checkGitHubBranchExists(
  installationId: number,
  owner: string,
  repo: string,
  branch: string
): Promise<boolean> {
  if (!githubApp) {
    throw new Error("GitHub App is not enabled");
  }

  if (!branch || branch.trim() === "") {
    return false;
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const [error] = await tryCatch(
    octokit.rest.repos.getBranch({
      owner,
      repo,
      branch,
    })
  );

  if (error && "status" in error && error.status === 404) {
    return false;
  }

  if (error) {
    logger.error("Error checking GitHub branch", {
      installationId,
      owner,
      repo,
      branch,
      error: error.message,
    });
    throw error;
  }

  return true;
}
