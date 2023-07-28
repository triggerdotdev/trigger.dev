import { User } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";

export class TriggersPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
  }) {
    const triggers = await this.#prismaClient.triggerSource.findMany({
      select: {
        id: true,
        active: true,
        dynamicTrigger: {
          select: {
            id: true,
            slug: true,
          },
        },
        integration: {
          select: {
            id: true,
            title: true,
            slug: true,
            definitionId: true,
            setupStatus: true,
            definition: {
              select: {
                icon: true,
              },
            },
          },
        },
        environment: {
          select: {
            type: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        params: true,
        registrations: true,
        sourceRegistrationJob: true,
      },
      where: {
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
        environment: {
          OR: [
            {
              orgMember: null,
            },
            {
              orgMember: {
                userId,
              },
            },
          ],
        },
        project: {
          slug: projectSlug,
        },
      },
    });

    return {
      triggers,
    };
  }
}
