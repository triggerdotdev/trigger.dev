import type { WorkflowRun, WorkflowRunStep } from ".prisma/client";
import type {
  CustomEventSchema,
  ErrorSchema,
  LogMessageSchema,
  WaitSchema,
} from "@trigger.dev/common-schemas";
import type { z } from "zod";
import { prisma } from "~/db.server";
import { IngestEvent } from "~/services/events/ingest.server";
import type { Organization } from "./organization.server";
import type { User } from "./user.server";
import type { Workflow } from "./workflow.server";

type WorkflowRunStatus = WorkflowRun["status"];
export type { WorkflowRun, WorkflowRunStep, WorkflowRunStatus };

export async function startWorkflowRun(id: string, apiKey: string) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  await prisma.workflowRun.update({
    where: { id: workflowRun.id },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
}

export async function failWorkflowRun(
  id: string,
  error: z.infer<typeof ErrorSchema>,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  await prisma.workflowRun.update({
    where: { id: workflowRun.id },
    data: {
      status: "ERROR",
      error,
      finishedAt: new Date(),
    },
  });
}

export async function completeWorkflowRun(
  id: string,
  output: string,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  await prisma.$transaction(async (tx) => {
    await tx.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
      },
    });

    await tx.workflowRunStep.create({
      data: {
        runId: id,
        type: "OUTPUT",
        output: JSON.parse(output),
        context: {},
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  });
}

export async function triggerEventInRun(
  id: string,
  event: z.infer<typeof CustomEventSchema>,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  await prisma.workflowRunStep.create({
    data: {
      runId: id,
      type: "CUSTOM_EVENT",
      input: event,
      context: {},
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });

  const ingestService = new IngestEvent();

  await ingestService.call(
    event,
    workflowRun.environment.organization,
    workflowRun.environment
  );
}

export async function logMessageInRun(
  id: string,
  log: z.infer<typeof LogMessageSchema>,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  await prisma.workflowRunStep.create({
    data: {
      runId: workflowRun.id,
      type: "LOG_MESSAGE",
      input: log,
      context: {},
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
}

export async function initiateWaitInRun(
  id: string,
  wait: z.infer<typeof WaitSchema>,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  await prisma.workflowRunStep.create({
    data: {
      runId: workflowRun.id,
      type: "DURABLE_DELAY",
      input: wait,
      context: {},
      startedAt: new Date(),
    },
  });
}

async function findWorkflowRunScopedToApiKey(id: string, apiKey: string) {
  const workflowRun = await prisma.workflowRun.findFirst({
    where: { id },
    include: {
      environment: {
        include: { organization: true },
      },
    },
  });

  if (!workflowRun || workflowRun.environment.apiKey !== apiKey) {
    throw new Error("Invalid workflow run");
  }

  return workflowRun;
}

export async function getWorkflowRuns({
  userId,
  organizationSlug,
  workflowSlug,
  page,
  pageSize = 20,
}: {
  userId: User["id"];
  organizationSlug: Organization["slug"];
  workflowSlug: Workflow["slug"];
  page: number;
  pageSize?: number;
}) {
  const offset = (page - 1) * pageSize;
  const total = await prisma.workflowRun.count({
    where: {
      workflow: {
        slug: workflowSlug,
      },
    },
  });

  const runs = await prisma.workflowRun.findMany({
    where: {
      workflow: {
        slug: workflowSlug,
        organization: {
          slug: organizationSlug,
          users: {
            some: {
              id: userId,
            },
          },
        },
      },
    },
    orderBy: {
      startedAt: "desc",
    },
    skip: offset,
    take: pageSize,
  });

  return {
    runs,
    page,
    total,
  };
}
