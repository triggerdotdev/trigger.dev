import type { GitHubAppAuthorization } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { CreateInstallationAccessTokenResponse } from "~/features/ee/projects/github/githubApp.server";
import { getInstallationRepositories } from "~/features/ee/projects/github/githubApp.server";
import { refreshInstallationAccessToken } from "~/features/ee/projects/github/refreshInstallationAccessToken.server";
import { MAX_LIVE_PROJECTS } from "~/consts";

export type InstallationRepository = NonNullable<
  CreateInstallationAccessTokenResponse["repositories"]
>[number];

export type RepositoryWithStatus = {
  repository: InstallationRepository;
  status: "relevant" | "unknown";
  appAuthorizationId: string;
  projectId?: string;
};

export class NewProjectPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(userId: string, organizationSlug: string) {
    const { admin } = await this.#prismaClient.user.findUniqueOrThrow({
      where: {
        id: userId,
      },
      select: {
        admin: true,
      },
    });

    const appAuthorizations =
      await this.#prismaClient.gitHubAppAuthorization.findMany({
        where: {
          user: {
            id: userId,
          },
        },
      });

    const projects = await this.#prismaClient.repositoryProject.findMany({
      where: {
        organization: {
          slug: organizationSlug,
        },
      },
      select: {
        name: true,
        id: true,
      },
    });

    const repositories = this.#findRepositoriesForAuthorizations(
      appAuthorizations,
      projects
    );

    return {
      appAuthorizations,
      redirectTo: `/orgs/${organizationSlug}/projects/new`,
      repositories,
      canDeployMoreProjects: admin || projects.length < MAX_LIVE_PROJECTS,
    };
  }

  async #findRepositoriesForAuthorizations(
    authorizations: GitHubAppAuthorization[],
    projects: Array<{ name: string; id: string }>,
    relevantRepositories: string[] = []
  ): Promise<
    Array<{
      repositories: Array<RepositoryWithStatus>;
      authorization: GitHubAppAuthorization;
    }>
  > {
    const repositories: Array<{
      repositories: Array<RepositoryWithStatus>;
      authorization: GitHubAppAuthorization;
    }> = [];

    for (const authorization of authorizations) {
      const validAuthorization = await refreshInstallationAccessToken(
        authorization
      );

      const installationRepositories = await getInstallationRepositories(
        validAuthorization.installationAccessToken
      );

      const repositoriesWithStatus = installationRepositories.map(
        (repository) => {
          const status = relevantRepositories.includes(repository.full_name)
            ? ("relevant" as const)
            : ("unknown" as const);

          const project = projects.find(
            (project) => project.name === repository.full_name
          );

          return {
            repository,
            status,
            appAuthorizationId: authorization.id,
            projectId: project?.id,
          };
        }
      );

      const sortedRepos = repositoriesWithStatus.sort((a, b) => {
        if (a.status === "relevant" && b.status === "unknown") {
          return -1;
        } else if (a.status === "unknown" && b.status === "relevant") {
          return 1;
        } else {
          if (!a.repository.pushed_at) {
            return 1;
          }

          if (!b.repository.pushed_at) {
            return -1;
          }

          return (
            new Date(b.repository.pushed_at).getTime() -
            new Date(a.repository.pushed_at).getTime()
          );
        }
      });

      repositories.push({
        repositories: sortedRepos,
        authorization,
      });
    }

    // Sort by the number of relevant repositories
    return repositories.sort((a, b) => {
      const aRelevant = a.repositories.filter(
        (repository) => repository.status === "relevant"
      ).length;
      const bRelevant = b.repositories.filter(
        (repository) => repository.status === "relevant"
      ).length;

      return bRelevant - aRelevant;
    });
  }
}
