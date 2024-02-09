import { PrismaClient, User } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export class NewOrganizationPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId }: { userId: User["id"] }) {
    const organizations = await this.#prismaClient.organization.findMany({
      select: {
        projects: {
          where: { deletedAt: null },
        },
      },
      where: { members: { some: { userId } } },
    });

    return {
      hasOrganizations: organizations.filter((o) => o.projects.length > 0).length > 0,
    };
  }
}
