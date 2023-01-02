import type { WaitSchema } from "@trigger.dev/common-schemas";
import type { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { calculateDurationInMs } from "~/utils/delays";
import { internalPubSub } from "../messageBroker.server";

type DelayConfig = z.infer<typeof WaitSchema>;

export class InitiateDelay {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(runId: string, delay: { id: string; config: DelayConfig }) {
    const delayUntil = this.#calculateDelayUntil(delay.config);

    // Make sure the delay is not more than 1 year in the future
    if (delayUntil.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
      throw new Error(
        `Delay is more than 1 year in the future, which is the maximum allowed by trigger.dev`
      );
    }

    const workflowStep = await this.#prismaClient.workflowRunStep.create({
      data: {
        runId,
        type: "DURABLE_DELAY",
        input: delay.config,
        context: { id: delay.id, delayUntil: delayUntil.toISOString() },
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    // Create the durable delay
    const durableDelay = await this.#prismaClient.durableDelay.create({
      data: {
        id: delay.id,
        runId,
        stepId: workflowStep.id,
        delayUntil: this.#calculateDelayUntil(delay.config),
      },
    });

    await internalPubSub.publish(
      "RESOLVE_DELAY",
      {
        id: delay.id,
      },
      {},
      { deliverAt: durableDelay.delayUntil.getTime() }
    );
  }

  #calculateDelayUntil(config: DelayConfig): Date {
    switch (config.type) {
      case "DELAY":
        return new Date(Date.now() + calculateDurationInMs(config));
      case "SCHEDULE_FOR":
        return new Date(config.scheduledFor);
    }
  }
}
