import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

export class StartAppInstallation {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    redirectTo,
    authorizationId,
  }: {
    userId: string;
    redirectTo: string;
    authorizationId?: string;
  }) {
    if (!env.GITHUB_APP_NAME) {
      return;
    }

    const attempt =
      await this.#prismaClient.gitHubAppAuthorizationAttempt.create({
        data: {
          userId,
          redirectTo,
          authorizationId,
        },
      });

    return `https://github.com/apps/${env.GITHUB_APP_NAME}/installations/new?state=${attempt.id}`;
  }
}
