import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { DisableWorkflow } from "./disableWorkflow.server";

export class ArchiveWorkflow {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(userId: string, organizationSlug: string, slug: string) {
    const organization = await this.#prismaClient.organization.findFirst({
      where: {
        slug: organizationSlug,
        users: {
          some: {
            id: userId,
          },
        },
      },
    });

    if (!organization) {
      return {
        status: "error" as const,
        message:
          "There was an issue archiving this workflow. Please contact help@trigger.dev for assistance.",
      };
    }

    const workflow = await this.#prismaClient.workflow.findFirst({
      where: {
        slug,
        organizationId: organization.id,
      },
    });

    if (!workflow) {
      return {
        status: "error" as const,
        message:
          "There was an issue archiving this workflow. Please contact help@trigger.dev for assistance.",
      };
    }

    if (workflow.isArchived) {
      return {
        status: "error" as const,
        message: "This workflow is already archived",
      };
    }

    const disableService = new DisableWorkflow();
    await disableService.call(userId, organizationSlug, slug);

    await this.#prismaClient.workflow.update({
      where: {
        id: workflow.id,
      },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    return {
      status: "success" as const,
    };
  }
}
