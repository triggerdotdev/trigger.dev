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
  }: {
    userId: string;
    redirectTo: string;
  }) {
    if (!env.GITHUB_APP_NAME) {
      return;
    }

    const attempt = await prisma.gitHubAppAuthorizationAttempt.create({
      data: {
        userId,
        redirectTo,
      },
    });

    return `https://github.com/apps/${env.GITHUB_APP_NAME}/installations/new?state=${attempt.id}`;
  }
}
