import type { WaitSchema } from "@trigger.dev/common-schemas";
import type { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { WorkflowRunStep } from "~/models/workflowRun.server";
import { createStepOnce } from "~/models/workflowRunStep.server";
import { calculateDurationInMs } from "~/utils/delays";
import { internalPubSub } from "../messageBroker.server";

type Wait = z.infer<typeof WaitSchema>;

export class InitiateDelay {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    runId: string,
    timestamp: string,
    delay: { key: string; wait: Wait }
  ) {
    const delayUntil = this.#calculateDelayUntil(delay.wait);

    // Make sure the delay is not more than 1 year in the future
    if (delayUntil.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
      throw new Error(
        `Delay is more than 1 year in the future, which is the maximum allowed by trigger.dev`
      );
    }

    const idempotentStep = await createStepOnce(runId, delay.key, {
      type: "DURABLE_DELAY",
      input: delay.wait,
      context: { delayUntil: delayUntil.toISOString() },
      status: "RUNNING",
      startedAt: new Date(),
      ts: timestamp,
    });

    if (idempotentStep.status === "EXISTING") {
      return this.#handleExistingStep(idempotentStep.step);
    }

    const workflowStep = idempotentStep.step;

    // Create the durable delay
    const durableDelay = await this.#prismaClient.durableDelay.create({
      data: {
        runId,
        stepId: workflowStep.id,
        delayUntil: this.#calculateDelayUntil(delay.wait),
      },
    });

    await internalPubSub.publish(
      "RESOLVE_DELAY",
      {
        id: durableDelay.id,
      },
      {},
      { deliverAt: durableDelay.delayUntil.getTime() }
    );
  }

  async #handleExistingStep(step: WorkflowRunStep) {
    const durableDelay = await this.#prismaClient.durableDelay.findUnique({
      where: {
        stepId: step.id,
      },
    });

    if (!durableDelay) {
      return;
    }

    if (durableDelay.resolvedAt) {
      await internalPubSub.publish("RESOLVE_DELAY", {
        id: durableDelay.id,
      });
    }
  }

  #calculateDelayUntil(config: Wait): Date {
    switch (config.type) {
      case "DELAY":
        return new Date(Date.now() + calculateDurationInMs(config));
      case "SCHEDULE_FOR":
        return new Date(config.scheduledFor);
    }
  }
}
