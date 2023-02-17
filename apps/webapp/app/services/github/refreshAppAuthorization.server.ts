import type { GitHubAppAuthorization } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { oauthApp } from "../github/githubApp.server";

export class RefreshAppAuthorizationService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(appAuthorization: GitHubAppAuthorization) {
    if (!oauthApp) {
      return appAuthorization;
    }

    // If tokenExpiresAt is within 30 minutes of expiring, refresh it
    if (
      appAuthorization.tokenExpiresAt.getTime() - Date.now() >
      30 * 60 * 1000
    ) {
      return appAuthorization;
    }

    const refreshedToken = await oauthApp.refreshToken({
      refreshToken: appAuthorization.refreshToken,
    });

    const updatedAppAuthorization =
      await this.#prismaClient.gitHubAppAuthorization.update({
        where: {
          id: appAuthorization.id,
        },
        data: {
          token: refreshedToken.authentication.token,
          tokenExpiresAt: refreshedToken.authentication.expiresAt,
          refreshToken: refreshedToken.authentication.refreshToken,
          refreshTokenExpiresAt:
            refreshedToken.authentication.refreshTokenExpiresAt,
        },
      });

    return updatedAppAuthorization;
  }
}
