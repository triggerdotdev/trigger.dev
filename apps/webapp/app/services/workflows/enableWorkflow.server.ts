import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ScheduleNextEvent } from "../scheduler/scheduleNextEvent.server";

export class EnableWorkflow {
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
          "There was an issue enabling this workflow. Please contact help@trigger.dev for assistance.",
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
          "There was an issue enabling this workflow. Please contact help@trigger.dev for assistance.",
      };
    }

    if (workflow.status === "READY" || workflow.status === "CREATED") {
      return {
        status: "error" as const,
        message: "This workflow is already enabled",
      };
    }

    if (workflow.isArchived) {
      return {
        status: "error" as const,
        message: "This workflow is already archived, and cannot be enabled",
      };
    }

    await this.#prismaClient.workflow.update({
      where: {
        id: workflow.id,
      },
      data: {
        status: "READY",
        disabledAt: null,
      },
    });

    await this.#prismaClient.eventRule.updateMany({
      where: {
        workflowId: workflow.id,
      },
      data: {
        enabled: true,
      },
    });

    if (workflow.type === "SCHEDULE") {
      const schedulers = await this.#prismaClient.schedulerSource.findMany({
        where: {
          workflowId: workflow.id,
        },
      });

      for (const scheduler of schedulers) {
        const scheduleNextEvent = new ScheduleNextEvent();
        await scheduleNextEvent.call(scheduler);
      }
    }

    return {
      status: "success" as const,
    };
  }
}
