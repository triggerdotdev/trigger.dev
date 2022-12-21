import type { WorkflowRunStep, WorkflowTrigger } from ".prisma/client";
import {
  CustomEventSchema,
  LogMessageSchema,
} from "@trigger.dev/common-schemas";
import { TriggerMetadataSchema } from "internal-platform";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { duration } from "~/utils";
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
        trigger: true,
        tasks: {
          orderBy: { startedAt: "asc" },
        },
      },
    });

    if (!workflowRun) {
      throw new Error(`Workflow run with id ${id} not found`);
    }

    const steps = await Promise.all(
      workflowRun.tasks.map((step, index) =>
        parseStep(
          step,
          workflowRun.status,
          index === workflowRun.tasks.length - 1
        )
      )
    );

    const trigger = {
      startedAt: workflowRun.startedAt,
      status: triggerStatus(steps.length, workflowRun.status),
      ...(await parseTrigger(workflowRun.trigger)),
    };

    return {
      id: workflowRun.id,
      status: workflowRun.status,
      startedAt: workflowRun.startedAt,
      finishedAt: workflowRun.finishedAt,
      duration:
        workflowRun.startedAt &&
        workflowRun.finishedAt &&
        duration(workflowRun.startedAt, workflowRun.finishedAt),
      trigger,
      steps,
      error: workflowRun.error,
    };
  }
}

async function parseTrigger(original: WorkflowTrigger) {
  return TriggerMetadataSchema.parseAsync(original);
}

async function parseStep(
  original: WorkflowRunStep,
  workflowStatus: WorkflowRunStatus,
  isLast: boolean
) {
  const status = stepStatus(original.finishedAt, workflowStatus, isLast);
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
        type: "LOG_MESSAGE",
        input: await LogMessageSchema.parseAsync(original.input),
      };
    case "CUSTOM_EVENT":
      return {
        ...base,
        type: "CUSTOM_EVENT",
        input: await CustomEventSchema.parseAsync(original.input),
      };
    case "OUTPUT":
      return {
        ...base,
        type: "OUTPUT",
        output: original.output,
      };
  }

  throw new Error(`Unknown step type ${original.type}`);
}

function stepStatus(
  finishedAt: Date | null,
  workflowStatus: WorkflowRunStatus,
  isLast: boolean
) {
  if (isLast) {
    return workflowStatus;
  }
  if (finishedAt) {
    return "SUCCESS";
  } else {
    return "PENDING";
  }
}

function triggerStatus(stepCount: number, workflowStatus: WorkflowRunStatus) {
  if (stepCount > 0) {
    return "SUCCESS";
  }

  return workflowStatus;
}
