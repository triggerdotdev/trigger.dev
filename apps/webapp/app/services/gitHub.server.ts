import { App, type Octokit } from "octokit";
import { env } from "../env.server";
import { prisma } from "~/db.server";

export const githubApp = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_APP_WEBHOOK_SECRET,
  },
});

/**
 * Links a GitHub App installation to a Trigger organization
 */
export async function linkGitHubAppInstallation(
  installationId: number,
  organizationId: string
): Promise<void> {
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
      permissions: installation.permissions,
      repositorySelection,
      repositories: {
        create: repositories,
      },
    },
  });
}

async function fetchInstallationRepositories(octokit: Octokit, installationId: number) {
  const all = [];
  let page = 1;
  const perPage = 100;
  const maxPages = 3;

  while (page <= maxPages) {
    const { data: repoData } = await octokit.rest.apps.listReposAccessibleToInstallation({
      installation_id: installationId,
      per_page: perPage,
      page,
    });

    all.push(...repoData.repositories);

    if (repoData.repositories.length < perPage) {
      break;
    }

    page++;
  }

  return all.map((repo) => ({
    githubId: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    private: repo.private,
  }));
}
