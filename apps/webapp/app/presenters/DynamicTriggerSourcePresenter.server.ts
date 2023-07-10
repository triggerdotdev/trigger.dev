import { TriggerSource, User } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";

export class DynamicTriggerSourcePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    triggerSourceId,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    triggerSourceId: TriggerSource["id"];
  }) {
    const trigger = await this.#prismaClient.triggerSource.findUnique({
      select: {
        id: true,
        active: true,
        dynamicTrigger: true,
        integration: {
          select: {
            id: true,
            title: true,
            slug: true,
            definitionId: true,
            setupStatus: true,
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
        id: triggerSourceId,
      },
    });

    return {
      trigger,
    };
  }
}
