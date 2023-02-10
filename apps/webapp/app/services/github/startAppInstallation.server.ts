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
    organizationSlug,
  }: {
    userId: string;
    organizationSlug: string;
  }) {
    if (!env.GITHUB_APP_NAME) {
      return;
    }

    const organization = await this.#prismaClient.organization.findUnique({
      where: {
        slug: organizationSlug,
      },
    });

    if (!organization) {
      return;
    }

    const attempt = await prisma.gitHubAppAuthorizationAttempt.create({
      data: {
        organizationId: organization.id,
        userId,
      },
    });

    return `https://github.com/apps/${env.GITHUB_APP_NAME}/installations/new?state=${attempt.id}`;
  }
}
