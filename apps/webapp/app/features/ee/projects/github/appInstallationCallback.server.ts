import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getAppInstallation } from "~/features/ee/projects/github/githubApp.server";
import { workerQueue } from "~/services/worker.server";

export class AppInstallationCallback {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    state,
    installation_id,
    setup_action,
  }: {
    state: string;
    installation_id: string;
    setup_action: "install" | "update";
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

    if (attempt.authorizationId) {
      return attempt.redirectTo;
    }

    const installation = await getAppInstallation({
      installation_id: Number(installation_id),
    });

    if (!installation || !installation.account || !installation.account.login) {
      return;
    }

    const existingAuthorization =
      await this.#prismaClient.gitHubAppAuthorization.findUnique({
        where: {
          installationId: installation.id,
        },
      });

    if (existingAuthorization) {
      await this.#prismaClient.gitHubAppAuthorizationAttempt.delete({
        where: {
          id: attempt.id,
        },
      });

      await this.#prismaClient.gitHubAppAuthorization.update({
        where: {
          id: existingAuthorization.id,
        },
        data: {
          events: installation.events,
          permissions: installation.permissions,
          repositorySelection: installation.repository_selection,
        },
      });

      return attempt.redirectTo;
    }

    const authorization =
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

    await workerQueue.enqueue("githubAppInstallationCreated", {
      id: authorization.id,
    });

    return attempt.redirectTo;
  }
}
