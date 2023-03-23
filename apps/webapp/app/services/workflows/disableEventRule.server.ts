import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { logger } from "../logger";

export class DisableEventRule {
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

    if (!eventRule.enabled) {
      return;
    }

    logger.debug("Disabling event rule", { eventRule });

    await this.#prismaClient.eventRule.update({
      where: {
        id: eventRuleId,
      },
      data: {
        enabled: false,
      },
    });
  }
}
