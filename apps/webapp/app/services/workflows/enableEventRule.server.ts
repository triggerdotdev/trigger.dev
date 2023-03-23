import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { logger } from "../logger";

export class EnableEventRule {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(eventRuleId: string) {
    const eventRule = await this.#prismaClient.eventRule.findUniqueOrThrow({
      where: {
        id: eventRuleId,
      },
      include: {
        workflow: true,
      },
    });

    if (eventRule.workflow.isArchived) {
      throw new Error("This workflow is archived, and cannot be enabled");
    }

    if (eventRule.enabled) {
      return;
    }

    logger.debug("Enabling event rule", { eventRule });

    await this.#prismaClient.eventRule.update({
      where: {
        id: eventRuleId,
      },
      data: {
        enabled: true,
      },
    });
  }
}
