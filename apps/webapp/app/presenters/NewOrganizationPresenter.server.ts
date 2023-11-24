import { PrismaClient, User } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export class NewOrganizationPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId }: { userId: User["id"] }) {
    const organizations = await this.#prismaClient.organization.findMany({
      where: { members: { some: { userId } } },
    });

    return {
      hasOrganizations: organizations.length > 0,
    };
  }
}
