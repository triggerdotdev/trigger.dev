import type { GitHubAppAuthorization } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { CreateInstallationAccessTokenResponse } from "~/services/github/githubApp.server";
import { getInstallationRepositories } from "~/services/github/githubApp.server";
import { refreshInstallationAccessToken } from "~/services/github/refreshInstallationAccessToken.server";

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

    const repositories =
      this.#findRepositoriesForAuthorizations(appAuthorizations);

    return {
      appAuthorizations,
      redirectTo: `/orgs/${organizationSlug}/projects/new`,
      repositories,
    };
  }

  async #findRepositoriesForAuthorizations(
    authorizations: GitHubAppAuthorization[]
  ) {
    const repositories: CreateInstallationAccessTokenResponse["repositories"] =
      [];

    for (const authorization of authorizations) {
      const validAuthorization = await refreshInstallationAccessToken(
        authorization
      );

      const installationRepositories = await getInstallationRepositories(
        validAuthorization.installationAccessToken
      );

      repositories.push(...installationRepositories);
    }

    // sorted by pushed at desc
    return repositories.sort((a, b) => {
      if (!a.pushed_at) {
        return 1;
      }

      if (!b.pushed_at) {
        return -1;
      }

      return new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime();
    });
  }
}
