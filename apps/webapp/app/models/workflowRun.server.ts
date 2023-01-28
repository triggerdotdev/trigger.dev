import type { WorkflowRun, WorkflowRunStep } from ".prisma/client";
import type { WorkflowRunStatus } from ".prisma/client";
import type {
  CustomEventSchema,
  ErrorSchema,
  LogMessageSchema,
} from "@trigger.dev/common-schemas";
import { ulid } from "ulid";
import type { z } from "zod";
import { prisma } from "~/db.server";
import { IngestEvent } from "~/services/events/ingest.server";
import { createStepOnce } from "./workflowRunStep.server";

export type { WorkflowRun, WorkflowRunStep, WorkflowRunStatus };

export async function findWorklowRunById(id: string) {
  return prisma.workflowRun.findUnique({
    where: { id },
    include: {
      event: true,
      environment: true,
      workflow: true,
    },
  });
}

export async function startWorkflowRun(id: string, apiKey: string) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  if (!isWorkflowPending(workflowRun)) {
    console.log(
      `[startWorkflowRun] ${workflowRun.id} is not pending, skipping`
    );

    return;
  }

  if (workflowRun.status === "DISCONNECTED") {
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
      },
    });

    await resolveDisconnectionStepsInRun(workflowRun.id);
  } else {
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });
  }
}

export async function failWorkflowRun(
  id: string,
  error: z.infer<typeof ErrorSchema>,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  if (!isWorkflowRunningOrPending(workflowRun)) {
    console.log(`[failWorkflowRun] ${workflowRun.id} is not running, skipping`);

    return;
  }

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
  runId: string,
  apiKey: string,
  timestamp: string,
  output?: string | null
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(runId, apiKey);

  if (!isWorkflowRunningOrPending(workflowRun)) {
    console.log(
      `[completeWorkflowRun] ${workflowRun.id} is not running, skipping`
    );

    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
      },
    });

    const parsedOutput =
      typeof output === "string" ? JSON.parse(output) : undefined;

    await tx.workflowRunStep.upsert({
      where: {
        runId_idempotencyKey: {
          runId,
          idempotencyKey: "output",
        },
      },
      create: {
        runId,
        idempotencyKey: "output",
        type: "OUTPUT",
        output: parsedOutput === null ? undefined : parsedOutput,
        context: {},
        startedAt: new Date(),
        finishedAt: new Date(),
        ts: timestamp,
      },
      update: {},
    });
  });
}

export async function triggerEventInRun(
  key: string,
  event: z.infer<typeof CustomEventSchema>,
  runId: string,
  apiKey: string,
  timestamp: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(runId, apiKey);

  if (!isWorkflowRunningOrPending(workflowRun)) {
    console.log(
      `[triggerEventInRun] ${workflowRun.id} is not running, skipping`
    );

    return;
  }

  const step = await createStepOnce(runId, key, {
    type: "CUSTOM_EVENT",
    input: event,
    context: {},
    startedAt: new Date(),
    finishedAt: new Date(),
    ts: timestamp,
  });

  if (step.status === "EXISTING") {
    return;
  }

  const ingestService = new IngestEvent();

  await ingestService.call(
    {
      id: ulid(),
      name: event.name,
      type: "CUSTOM_EVENT",
      service: "trigger",
      payload: event.payload,
      context: event.context,
      apiKey: workflowRun.environment.apiKey,
    },
    workflowRun.environment.organization
  );

  await prisma.workflowRunStep.update({
    where: { id: step.step.id },
    data: {
      status: "SUCCESS",
    },
  });
}

export async function logMessageInRun(
  key: string,
  log: z.infer<typeof LogMessageSchema>,
  runId: string,
  apiKey: string,
  timestamp: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(runId, apiKey);

  if (!isWorkflowRunningOrPending(workflowRun)) {
    console.log(`[logMessageInRun] ${workflowRun.id} is not running, skipping`);

    return;
  }

  return createStepOnce(workflowRun.id, key, {
    type: "LOG_MESSAGE",
    input: log,
    context: {},
    status: "SUCCESS",
    startedAt: new Date(),
    finishedAt: new Date(),
    ts: timestamp,
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

export async function getMostRecentWorkflowRun({
  workflowSlug,
}: {
  workflowSlug: string;
}) {
  return prisma.workflowRun.findFirst({
    where: {
      workflow: {
        slug: workflowSlug,
      },
    },
    include: {
      event: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function resolveDisconnectionStepsInRun(runId: string) {
  return prisma.workflowRunStep.updateMany({
    where: {
      runId,
      type: "DISCONNECTION",
      status: "RUNNING",
    },
    data: {
      status: "SUCCESS",
      finishedAt: new Date(),
    },
  });
}

export function isWorkflowPending(workflowRun: WorkflowRun) {
  return (
    workflowRun.status === "PENDING" || workflowRun.status === "DISCONNECTED"
  );
}

export function isWorkflowRunning(workflowRun: WorkflowRun) {
  return (
    workflowRun.status === "RUNNING" || workflowRun.status === "DISCONNECTED"
  );
}

export function isWorkflowRunningOrPending(workflowRun: WorkflowRun) {
  return (
    workflowRun.status === "RUNNING" ||
    workflowRun.status === "DISCONNECTED" ||
    workflowRun.status === "PENDING"
  );
}
