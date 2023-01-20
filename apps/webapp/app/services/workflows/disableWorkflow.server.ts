import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class DisableWorkflow {
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
          "There was an issue disabling this workflow. Please contact help@trigger.dev for assistance.",
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
          "There was an issue disabling this workflow. Please contact help@trigger.dev for assistance.",
      };
    }

    if (workflow.status === "DISABLED") {
      return {
        status: "error" as const,
        message: "This workflow is already disabled",
      };
    }

    if (workflow.isArchived) {
      return {
        status: "error" as const,
        message: "This workflow is already archived, and cannot be disabled",
      };
    }

    const updatedWorkflow = await this.#prismaClient.workflow.update({
      where: {
        id: workflow.id,
      },
      data: {
        status: "DISABLED",
        disabledAt: new Date(),
      },
    });

    await this.#prismaClient.eventRule.updateMany({
      where: {
        workflowId: workflow.id,
      },
      data: {
        enabled: false,
      },
    });

    return {
      status: "success" as const,
      workflow: updatedWorkflow,
    };
  }
}
