import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getAppInstallation } from "~/services/github/githubApp.server";

export class AppInstallationCallback {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    state,
    installation_id,
  }: {
    state: string;
    installation_id: string;
  }) {
    const attempt =
      await this.#prismaClient.gitHubAppAuthorizationAttempt.findUnique({
        where: {
          id: state,
        },
      });

    if (!attempt) {
      return;
    }

    const installation = await getAppInstallation({
      installation_id: Number(installation_id),
    });

    if (!installation || !installation.account || !installation.account.login) {
      return;
    }

    await this.#prismaClient.gitHubAppAuthorization.create({
      data: {
        user: {
          connect: {
            id: attempt.userId,
          },
        },
        installationId: installation.id,
        account: installation.account,
        accountName: installation.account.login,
        permissions: installation.permissions,
        repositorySelection: installation.repository_selection,
        accessTokensUrl: installation.access_tokens_url,
        repositoriesUrl: installation.repositories_url,
        htmlUrl: installation.html_url,
        events: installation.events,
        accountType:
          installation.account?.type === "User" ? "USER" : "ORGANIZATION",
      },
    });

    await this.#prismaClient.gitHubAppAuthorizationAttempt.delete({
      where: {
        id: attempt.id,
      },
    });

    return attempt.redirectTo;
  }
}
