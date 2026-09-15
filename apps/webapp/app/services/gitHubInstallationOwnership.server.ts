import type { Octokit } from "octokit";

const installationsPerPage = 100;

type GitHubUserClient = Pick<Octokit, "request">;

export async function verifyGitHubAppInstallationAccess(
  userOctokit: GitHubUserClient,
  installationId: number
): Promise<void> {
  let page = 1;

  while (true) {
    const { data } = await userOctokit.request("GET /user/installations", {
      page,
      per_page: installationsPerPage,
    });

    if (data.installations.some((installation) => installation.id === installationId)) {
      return;
    }

    if (
      data.installations.length < installationsPerPage ||
      page * installationsPerPage >= data.total_count
    ) {
      break;
    }

    page++;
  }

  throw new Error("GitHub App installation is not accessible to the authenticated GitHub user");
}

export async function getAuthenticatedGitHubLogin(userOctokit: GitHubUserClient): Promise<string> {
  const { data } = await userOctokit.request("GET /user");

  if (!data.login) {
    throw new Error("GitHub did not return a login for the authenticated user");
  }

  return data.login;
}
