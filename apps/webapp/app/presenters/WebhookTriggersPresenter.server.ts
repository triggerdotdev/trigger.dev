import { type Organization, type User } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";

export class WebhookTriggersPresenter {
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
    const webhooks = await this.#prismaClient.webhook.findMany({
      select: {
        id: true,
        key: true,
        active: true,
        params: true,
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
        webhookEnvironments: {
          select: {
            id: true,
            environment: {
              select: {
                type: true
              }
            }
          }
        },
        createdAt: true,
        updatedAt: true,
      },
      where: {
        project: {
          slug: projectSlug,
          organization: {
            slug: organizationSlug,
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    return { webhooks };
  }
}
