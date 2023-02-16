import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import {
  getAppInstallation,
  oauthApp,
  octokit,
} from "~/services/github/githubApp.server";

export class AppInstallationCallback {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    code,
    state,
    installation_id,
  }: {
    code: string;
    state: string;
    installation_id: string;
  }) {
    if (!oauthApp || !octokit) {
      return;
    }

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

    const { authentication } = await oauthApp.createToken({ code, state });

    const authorization =
      await this.#prismaClient.gitHubAppAuthorization.create({
        data: {
          user: {
            connect: {
              id: attempt.userId,
            },
          },
          organization: {
            connect: {
              id: attempt.organizationId,
            },
          },
          token: authentication.token,
          // @ts-ignore
          tokenExpiresAt: new Date(authentication.expiresAt),
          // @ts-ignore
          refreshToken: authentication.refreshToken,
          // @ts-ignore
          refreshTokenExpiresAt: new Date(authentication.refreshTokenExpiresAt),
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
        include: {
          organization: {
            select: {
              slug: true,
            },
          },
        },
      });

    await this.#prismaClient.gitHubAppAuthorizationAttempt.delete({
      where: {
        id: attempt.id,
      },
    });

    return { authorization, templateId: attempt.templateId };
  }
}
