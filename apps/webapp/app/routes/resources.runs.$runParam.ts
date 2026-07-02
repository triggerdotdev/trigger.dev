import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prettyPrintPacket, TaskRunError } from "@trigger.dev/core/v3";
import type { UseDataFunctionReturn } from "remix-typedjson";
import { typedjson } from "remix-typedjson";
import { RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { $replica, prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { machinePresetFromRun } from "~/v3/machinePresets.server";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { FINAL_ATTEMPT_STATUSES, isFinalRunStatus } from "~/v3/taskStatus";

export type RunInspectorData = UseDataFunctionReturn<typeof loader>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const parsedParams = v3RunParamsSchema.pick({ runParam: true }).parse(params);

  const run = await runStore.findRun(
    {
      friendlyId: parsedParams.runParam,
    },
    {
      select: {
        id: true,
        traceId: true,
        //metadata
        number: true,
        taskIdentifier: true,
        friendlyId: true,
        isTest: true,
        runTags: true,
        machinePreset: true,
        runtimeEnvironmentId: true,
        projectId: true,
        lockedById: true,
        lockedToVersionId: true,
        //status + duration
        status: true,
        startedAt: true,
        createdAt: true,
        updatedAt: true,
        queuedAt: true,
        completedAt: true,
        logsDeletedAt: true,
        //idempotency
        idempotencyKey: true,
        //delayed
        delayUntil: true,
        //ttl
        ttl: true,
        expiredAt: true,
        //queue
        queue: true,
        concurrencyKey: true,
        //schedule
        scheduleId: true,
        //usage
        baseCostInCents: true,
        costInCents: true,
        usageDurationMs: true,
        payload: true,
        payloadType: true,
        metadata: true,
        metadataType: true,
        maxAttempts: true,
        parentTaskRun: {
          select: {
            friendlyId: true,
          },
        },
        rootTaskRun: {
          select: {
            friendlyId: true,
          },
        },
      },
    }
  );

  if (!run) {
    throw new Response("Not found", { status: 404 });
  }

  const authorizedProject = await prisma.project.findFirst({
    where: { id: run.projectId, organization: { members: { some: { userId } } } },
    select: { id: true },
  });

  if (!authorizedProject) {
    throw new Response("Not found", { status: 404 });
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment) {
    throw new Response("Run environment not found", { status: 404 });
  }

  const lockedWorker = await controlPlaneResolver.resolveRunLockedWorker({
    lockedById: run.lockedById,
    lockedToVersionId: run.lockedToVersionId,
  });

  const isFinished = isFinalRunStatus(run.status);

  const finishedAttempt = isFinished
    ? await runStore.findTaskRunAttempt({
        select: {
          output: true,
          outputType: true,
          error: true,
        },
        where: {
          status: { in: FINAL_ATTEMPT_STATUSES },
          taskRunId: run.id,
        },
        orderBy: {
          createdAt: "desc",
        },
      })
    : null;

  const output =
    finishedAttempt === null
      ? undefined
      : finishedAttempt.outputType === "application/store"
        ? `/resources/packets/${environment.id}/${finishedAttempt.output}`
        : typeof finishedAttempt.output !== "undefined" && finishedAttempt.output !== null
          ? await prettyPrintPacket(finishedAttempt.output, finishedAttempt.outputType ?? undefined)
          : undefined;

  const payload =
    run.payloadType === "application/store"
      ? `/resources/packets/${environment.id}/${run.payload}`
      : typeof run.payload !== "undefined" && run.payload !== null
        ? await prettyPrintPacket(run.payload, run.payloadType ?? undefined)
        : undefined;

  let error: TaskRunError | undefined = undefined;
  if (finishedAttempt?.error) {
    const result = TaskRunError.safeParse(finishedAttempt.error);
    if (result.success) {
      error = result.data;
    } else {
      error = {
        type: "CUSTOM_ERROR",
        raw: JSON.stringify(finishedAttempt.error),
      };
    }
  }

  const context = {
    task: {
      id: run.taskIdentifier,
      filePath: lockedWorker?.lockedBy?.filePath,
      exportName: "@deprecated",
    },
    run: {
      id: run.friendlyId,
      createdAt: run.createdAt,
      tags: run.runTags ?? [],
      isTest: run.isTest,
      idempotencyKey: run.idempotencyKey ?? undefined,
      startedAt: run.startedAt ?? run.createdAt,
      durationMs: run.usageDurationMs,
      costInCents: run.costInCents,
      baseCostInCents: run.baseCostInCents,
      maxAttempts: run.maxAttempts ?? undefined,
      version: lockedWorker?.lockedToVersion?.version,
      parentTaskRunId: run.parentTaskRun?.friendlyId ?? undefined,
      rootTaskRunId: run.rootTaskRun?.friendlyId ?? undefined,
    },
    queue: {
      name: run.queue,
    },
    environment: {
      id: environment.id,
      slug: environment.slug,
      type: environment.type,
    },
    organization: {
      id: environment.organization.id,
      slug: environment.organization.slug,
      name: environment.organization.title,
    },
    project: {
      id: environment.project.id,
      ref: environment.project.externalRef,
      slug: environment.project.slug,
      name: environment.project.name,
    },
    machine: run.machinePreset ? machinePresetFromRun(run) : undefined,
    deployment: lockedWorker?.lockedBy?.worker.deployment
      ? {
          id: lockedWorker.lockedBy.worker.deployment.friendlyId,
          shortCode: lockedWorker.lockedBy.worker.deployment.shortCode,
          version: lockedWorker.lockedBy.worker.deployment.version,
          runtime: lockedWorker.lockedBy.worker.deployment.runtime,
          runtimeVersion: lockedWorker.lockedBy.worker.deployment.runtimeVersion,
          git: lockedWorker.lockedBy.worker.deployment.git,
        }
      : undefined,
  };

  return typedjson({
    friendlyId: run.friendlyId,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    delayUntil: run.delayUntil,
    expiredAt: run.expiredAt,
    completedAt: run.completedAt,
    logsDeletedAt: run.logsDeletedAt,
    ttl: run.ttl,
    taskIdentifier: run.taskIdentifier,
    version: lockedWorker?.lockedToVersion?.version,
    sdkVersion: lockedWorker?.lockedToVersion?.sdkVersion,
    isTest: run.isTest,
    environmentId: environment.id,
    schedule: await resolveSchedule(run.scheduleId ?? undefined),
    queue: {
      name: run.queue,
      isCustomQueue: !run.queue.startsWith("task/"),
      concurrencyKey: run.concurrencyKey,
    },
    tags: run.runTags ?? [],
    baseCostInCents: run.baseCostInCents,
    costInCents: run.costInCents,
    totalCostInCents: run.costInCents + run.baseCostInCents,
    usageDurationMs: run.usageDurationMs,
    isFinished,
    isRunning: RUNNING_STATUSES.includes(run.status),
    payload,
    payloadType: run.payloadType,
    output,
    outputType: finishedAttempt?.outputType ?? "application/json",
    error,
    context: JSON.stringify(context, null, 2),
  });
};

async function resolveSchedule(scheduleId?: string) {
  if (!scheduleId) {
    return;
  }

  const schedule = await $replica.taskSchedule.findFirst({
    where: {
      id: scheduleId,
    },
    select: {
      friendlyId: true,
      generatorExpression: true,
      timezone: true,
      generatorDescription: true,
    },
  });

  if (!schedule) {
    return;
  }

  return {
    friendlyId: schedule.friendlyId,
    generatorExpression: schedule.generatorExpression,
    description: schedule.generatorDescription,
    timezone: schedule.timezone,
  };
}
