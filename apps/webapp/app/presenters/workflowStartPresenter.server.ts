import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AccountSchema } from "~/services/github/githubApp.server";

export class WorkflowStartPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({
    organizationSlug,
    userId,
  }: {
    organizationSlug: string;
    userId: string;
  }) {
    const appAuthorizations =
      await this.#prismaClient.gitHubAppAuthorization.findMany({
        where: {
          organization: {
            slug: organizationSlug,
          },
          user: {
            id: userId,
          },
        },
        select: {
          id: true,
          account: true,
          installationId: true,
          permissions: true,
          repositorySelection: true,
        },
      });

    const authorizationsWithAccounts = appAuthorizations.map(
      (appAuthorization) => {
        const account = AccountSchema.parse(appAuthorization.account);

        return {
          ...appAuthorization,
          account,
        };
      }
    );

    const templates = await this.#prismaClient.template.findMany({
      orderBy: {
        priority: "asc",
      },
    });

    return {
      appAuthorizations: authorizationsWithAccounts,
      templates,
    };
  }
}
