import type { WorkflowRunStep } from ".prisma/client";
import {
  CustomEventSchema,
  ErrorSchema,
  LogMessageSchema,
} from "@trigger.dev/common-schemas";
import { TriggerMetadataSchema } from "@trigger.dev/common-schemas";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { dateDifference } from "~/utils";
import type { WorkflowRunStatus } from "./workflowRun.server";

export class WorkflowRunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(id: string) {
    const workflowRun = await this.#prismaClient.workflowRun.findUnique({
      where: { id },
      include: {
        eventRule: true,
        event: true,
        tasks: {
          orderBy: { startedAt: "asc" },
        },
      },
    });

    if (!workflowRun) {
      throw new Error(`Workflow run with id ${id} not found`);
    }

    const steps = await Promise.all(
      workflowRun.tasks.map((step) => parseStep(step))
    );

    const trigger = {
      startedAt: workflowRun.startedAt,
      status: triggerStatus(steps.length, workflowRun.status),
      input: workflowRun.event.payload,
      ...(await parseTrigger(workflowRun.eventRule.trigger)),
    };

    return {
      id: workflowRun.id,
      status: workflowRun.status,
      startedAt: workflowRun.startedAt,
      finishedAt: workflowRun.finishedAt,
      isTest: workflowRun.isTest,
      duration:
        workflowRun.startedAt &&
        workflowRun.finishedAt &&
        dateDifference(workflowRun.startedAt, workflowRun.finishedAt),
      trigger,
      steps,
      error: workflowRun.error
        ? await ErrorSchema.parseAsync(workflowRun.error)
        : undefined,
    };
  }
}

async function parseTrigger(original: unknown) {
  return TriggerMetadataSchema.parseAsync(original);
}

async function parseStep(original: WorkflowRunStep) {
  const status = stepStatus(original.finishedAt);
  const base = {
    id: original.id,
    startedAt: original.startedAt,
    finishedAt: original.finishedAt,
    status,
  };
  switch (original.type) {
    case "LOG_MESSAGE":
      return {
        ...base,
        type: "LOG_MESSAGE" as const,
        input: await LogMessageSchema.parseAsync(original.input),
      };
    case "CUSTOM_EVENT":
      return {
        ...base,
        type: "CUSTOM_EVENT" as const,
        input: await CustomEventSchema.parseAsync(original.input),
      };
    case "OUTPUT":
      return {
        ...base,
        type: "OUTPUT" as const,
        output: original.output,
      };
  }

  throw new Error(`Unknown step type ${original.type}`);
}

function stepStatus(finishedAt: Date | null) {
  if (finishedAt) {
    return "SUCCESS" as const;
  } else {
    return "PENDING" as const;
  }
}

function triggerStatus(stepCount: number, workflowStatus: WorkflowRunStatus) {
  if (stepCount > 0) {
    return "SUCCESS" as const;
  }

  return workflowStatus;
}
