import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { analytics } from "../analytics.server";

export class OrganizationCreatedEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string): Promise<boolean> {
    const organization = await this.#prismaClient.organization.findUnique({
      where: { id },
      include: {
        users: {
          select: {
            id: true,
            _count: {
              select: { organizations: true },
            },
          },
        },
      },
    });

    if (!organization) {
      console.error(`Organization ${id} not found`);
      return false;
    }

    analytics.organization.identify({ organization });
    organization.users.forEach((user) => {
      analytics.organization.new({
        organization,
        userId: user.id,
        organizationCount: user._count.organizations,
      });
    });

    return true;
  }
}
