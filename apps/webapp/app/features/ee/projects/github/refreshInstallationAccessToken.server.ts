import type { GitHubAppAuthorization } from ".prisma/client";
import { prisma } from "~/db.server";
import { createInstallationAccessToken } from "./githubApp.server";

export type GitHubAppAuthorizationWithValidToken = GitHubAppAuthorization & {
  installationAccessToken: string;
  installationAccessTokenExpiresAt: Date;
};

export async function refreshInstallationAccessToken(
  authorizationOrId: GitHubAppAuthorization | string
): Promise<GitHubAppAuthorizationWithValidToken> {
  const authorization =
    typeof authorizationOrId === "string"
      ? await prisma.gitHubAppAuthorization.findUnique({
          where: {
            id: authorizationOrId,
          },
        })
      : authorizationOrId;

  if (!authorization) {
    throw new Error("App authorization not found");
  }

  // Make sure the access token is not expired, or less than 10 minutes from expiring
  const accessTokenExpired =
    !authorization.installationAccessTokenExpiresAt ||
    authorization.installationAccessTokenExpiresAt.getTime() <
      Date.now() + 10 * 60 * 1000;

  if (accessTokenExpired) {
    const accessToken = await createInstallationAccessToken(
      authorization.accessTokensUrl
    );

    const updatedAppAuthorization = await prisma.gitHubAppAuthorization.update({
      where: {
        id: authorization.id,
      },
      data: {
        installationAccessToken: accessToken.token,
        installationAccessTokenExpiresAt: new Date(accessToken.expires_at),
      },
    });

    return updatedAppAuthorization as GitHubAppAuthorizationWithValidToken;
  }

  return authorization as GitHubAppAuthorizationWithValidToken;
}
