import type { InitializeRunOnceSchema } from "@trigger.dev/common-schemas";
import type { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { WorkflowRunStep } from "~/models/workflowRun.server";
import { createStepOnce } from "~/models/workflowRunStep.server";
import { taskQueue } from "../messageBroker.server";

type RunOnce = z.infer<typeof InitializeRunOnceSchema>;

export class InitializeRunOnce {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(runId: string, key: string, timestamp: string, runOnce: RunOnce) {
    const idempotentStep = await createStepOnce(runId, key, {
      type: "RUN_ONCE",
      status: "RUNNING",
      startedAt: new Date(),
      context: {},
      ts: timestamp,
    });

    if (idempotentStep.status === "EXISTING") {
      return this.#handleExistingStep(idempotentStep.step);
    }

    const workflowStep = idempotentStep.step;

    return this.#handleNewStep(workflowStep, runOnce);
  }

  async #handleExistingStep(step: WorkflowRunStep) {
    return taskQueue.publish(
      "RESOLVE_RUN_ONCE",
      {
        stepId: step.id,
        hasRun: true,
      },
      {}
    );
  }

  async #handleNewStep(step: WorkflowRunStep, runOnce: RunOnce) {
    if (runOnce.type === "LOCAL_ONLY") {
      await this.#prismaClient.workflowRunStep.update({
        where: {
          id: step.id,
        },
        data: {
          status: "SUCCESS",
          finishedAt: new Date(),
        },
      });
    }

    return taskQueue.publish(
      "RESOLVE_RUN_ONCE",
      {
        stepId: step.id,
        hasRun: false,
      },
      {}
    );
  }
}
