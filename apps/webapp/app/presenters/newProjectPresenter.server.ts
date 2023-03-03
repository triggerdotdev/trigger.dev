import type { GitHubAppAuthorization } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getRepositoryFromMetadata } from "~/models/workflow.server";
import type { CreateInstallationAccessTokenResponse } from "~/services/github/githubApp.server";
import { getInstallationRepositories } from "~/services/github/githubApp.server";
import { refreshInstallationAccessToken } from "~/services/github/refreshInstallationAccessToken.server";

export type InstallationRepository = NonNullable<
  CreateInstallationAccessTokenResponse["repositories"]
>[number];

export type RepositoryWithStatus = {
  repository: InstallationRepository;
  status: "relevant" | "unknown";
};

export class NewProjectPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(userId: string, organizationSlug: string) {
    const appAuthorizations =
      await this.#prismaClient.gitHubAppAuthorization.findMany({
        where: {
          user: {
            id: userId,
          },
        },
      });

    const relevantRepositories =
      await this.#gatherRepositoriesFromWorkflowsInOrganization(
        organizationSlug
      );

    const repositories = this.#findRepositoriesForAuthorizations(
      appAuthorizations,
      relevantRepositories
    );

    return {
      appAuthorizations,
      redirectTo: `/orgs/${organizationSlug}/projects/new`,
      repositories,
    };
  }

  async #findRepositoriesForAuthorizations(
    authorizations: GitHubAppAuthorization[],
    relevantRepositories: string[] = []
  ): Promise<Array<RepositoryWithStatus>> {
    const repositories: Array<RepositoryWithStatus> = [];

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

          return {
            repository,
            status,
          };
        }
      );

      repositories.push(...repositoriesWithStatus);
    }

    // Sort by the relevant repositories first, then by the most recently updated
    return repositories.sort((a, b) => {
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
  }

  async #gatherRepositoriesFromWorkflowsInOrganization(
    organizationSlug: string
  ) {
    const workflows = await this.#prismaClient.workflow.findMany({
      where: {
        organization: {
          slug: organizationSlug,
        },
      },
      select: {
        metadata: true,
      },
    });

    return workflows
      .map((workflow) => getRepositoryFromMetadata(workflow.metadata))
      .filter(Boolean);
  }
}
