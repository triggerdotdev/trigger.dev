import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { MachinePresetName, prettyPrintPacket, TaskRunError } from "@trigger.dev/core/v3";
import { typedjson, UseDataFunctionReturn } from "remix-typedjson";
import { RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { $replica } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { machinePresetFromName, machinePresetFromRun } from "~/v3/machinePresets.server";
import { FINAL_ATTEMPT_STATUSES, isFinalRunStatus } from "~/v3/taskStatus";

export type RunInspectorData = UseDataFunctionReturn<typeof loader>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const parsedParams = v3RunParamsSchema.pick({ runParam: true }).parse(params);

  const run = await $replica.taskRun.findFirst({
    select: {
      id: true,
      traceId: true,
      //metadata
      number: true,
      taskIdentifier: true,
      friendlyId: true,
      isTest: true,
      tags: {
        select: {
          name: true,
        },
      },
      machinePreset: true,
      lockedToVersion: {
        select: {
          version: true,
          sdkVersion: true,
        },
      },
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
      //env
      runtimeEnvironment: {
        select: { id: true, slug: true, type: true },
      },
      payload: true,
      payloadType: true,
      metadata: true,
      metadataType: true,
      maxAttempts: true,
      project: {
        include: {
          organization: true,
        },
      },
      lockedBy: {
        select: {
          filePath: true,
          worker: {
            select: {
              deployment: {
                select: {
                  friendlyId: true,
                  shortCode: true,
                  version: true,
                  runtime: true,
                  runtimeVersion: true,
                  git: true,
                },
              },
            },
          },
        },
      },
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
    where: {
      friendlyId: parsedParams.runParam,
      project: {
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    },
  });

  if (!run) {
    throw new Response("Not found", { status: 404 });
  }

  const isFinished = isFinalRunStatus(run.status);

  const finishedAttempt = isFinished
    ? await $replica.taskRunAttempt.findFirst({
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
      ? `/resources/packets/${run.runtimeEnvironment.id}/${finishedAttempt.output}`
      : typeof finishedAttempt.output !== "undefined" && finishedAttempt.output !== null
      ? await prettyPrintPacket(finishedAttempt.output, finishedAttempt.outputType ?? undefined)
      : undefined;

  const payload =
    run.payloadType === "application/store"
      ? `/resources/packets/${run.runtimeEnvironment.id}/${run.payload}`
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
      filePath: run.lockedBy?.filePath,
      exportName: "@deprecated",
    },
    run: {
      id: run.friendlyId,
      createdAt: run.createdAt,
      tags: run.tags.map((tag) => tag.name),
      isTest: run.isTest,
      idempotencyKey: run.idempotencyKey ?? undefined,
      startedAt: run.startedAt ?? run.createdAt,
      durationMs: run.usageDurationMs,
      costInCents: run.costInCents,
      baseCostInCents: run.baseCostInCents,
      maxAttempts: run.maxAttempts ?? undefined,
      version: run.lockedToVersion?.version,
      parentTaskRunId: run.parentTaskRun?.friendlyId ?? undefined,
      rootTaskRunId: run.rootTaskRun?.friendlyId ?? undefined,
      concurrencyKey: run.concurrencyKey ?? undefined,
    },
    queue: {
      name: run.queue,
    },
    environment: {
      id: run.runtimeEnvironment.id,
      slug: run.runtimeEnvironment.slug,
      type: run.runtimeEnvironment.type,
    },
    organization: {
      id: run.project.organization.id,
      slug: run.project.organization.slug,
      name: run.project.organization.title,
    },
    project: {
      id: run.project.id,
      ref: run.project.externalRef,
      slug: run.project.slug,
      name: run.project.name,
    },
    machine: run.machinePreset ? machinePresetFromRun(run) : undefined,
    deployment: run.lockedBy?.worker.deployment
      ? {
          id: run.lockedBy.worker.deployment.friendlyId,
          shortCode: run.lockedBy.worker.deployment.shortCode,
          version: run.lockedBy.worker.deployment.version,
          runtime: run.lockedBy.worker.deployment.runtime,
          runtimeVersion: run.lockedBy.worker.deployment.runtimeVersion,
          git: run.lockedBy.worker.deployment.git,
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
    version: run.lockedToVersion?.version,
    sdkVersion: run.lockedToVersion?.sdkVersion,
    isTest: run.isTest,
    environmentId: run.runtimeEnvironment.id,
    schedule: await resolveSchedule(run.scheduleId ?? undefined),
    queue: {
      name: run.queue,
      isCustomQueue: !run.queue.startsWith("task/"),
      concurrencyKey: run.concurrencyKey,
    },
    tags: run.tags.map((tag) => tag.name),
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
