import {
  MachinePresetName,
  parsePacket,
  prettyPrintPacket,
  TaskRunError,
} from "@trigger.dev/core/v3";
import { RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { eventRepository } from "~/v3/eventRepository.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { FINAL_ATTEMPT_STATUSES, isFailedRunStatus, isFinalRunStatus } from "~/v3/taskStatus";
import { BasePresenter } from "./basePresenter.server";
import { getMaxDuration } from "~/v3/utils/maxDuration";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = NonNullable<NonNullable<Result>["span"]>;
export type SpanRun = NonNullable<NonNullable<Result>["run"]>;

export class SpanPresenter extends BasePresenter {
  public async call({
    userId,
    projectSlug,
    organizationSlug,
    spanId,
    runFriendlyId,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    spanId: string;
    runFriendlyId: string;
  }) {
    const project = await this._replica.project.findUnique({
      where: {
        slug: projectSlug,
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const run = await this.getRun(spanId);
    if (run) {
      return {
        type: "run" as const,
        run,
      };
    }

    //get the run
    const span = await this.getSpan(runFriendlyId, spanId);

    if (!span) {
      throw new Error("Span not found");
    }

    return {
      type: "span" as const,
      span,
    };
  }

  async getRun(spanId: string) {
    const run = await this._replica.taskRun.findFirst({
      select: {
        id: true,
        traceId: true,
        //metadata
        number: true,
        taskIdentifier: true,
        friendlyId: true,
        isTest: true,
        maxDurationInSeconds: true,
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
        schedule: {
          select: {
            friendlyId: true,
            generatorExpression: true,
            timezone: true,
            generatorDescription: true,
          },
        },
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
            exportName: true,
          },
        },
        //relationships
        rootTaskRun: {
          select: {
            taskIdentifier: true,
            friendlyId: true,
            spanId: true,
          },
        },
        parentTaskRun: {
          select: {
            taskIdentifier: true,
            friendlyId: true,
            spanId: true,
          },
        },
        batch: {
          select: {
            friendlyId: true,
          },
        },
      },
      where: {
        spanId,
      },
    });

    if (!run) {
      return;
    }

    const isFinished = isFinalRunStatus(run.status);

    const finishedAttempt = isFinished
      ? await this._replica.taskRunAttempt.findFirst({
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

    const span = await eventRepository.getSpan(spanId, run.traceId);

    const metadata = run.metadata
      ? await prettyPrintPacket(run.metadata, run.metadataType, {
          filteredKeys: ["$$streams", "$$streamsVersion", "$$streamsBaseUrl"],
        })
      : undefined;

    const context = {
      task: {
        id: run.taskIdentifier,
        filePath: run.lockedBy?.filePath,
        exportName: run.lockedBy?.exportName,
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
        maxDuration: run.maxDurationInSeconds ?? undefined,
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
      machine: run.machinePreset
        ? machinePresetFromName(run.machinePreset as MachinePresetName)
        : undefined,
    };

    return {
      id: run.id,
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
      schedule: run.schedule
        ? {
            friendlyId: run.schedule.friendlyId,
            generatorExpression: run.schedule.generatorExpression,
            description: run.schedule.generatorDescription,
            timezone: run.schedule.timezone,
          }
        : undefined,
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
      isError: isFailedRunStatus(run.status),
      payload,
      payloadType: run.payloadType,
      output,
      outputType: finishedAttempt?.outputType ?? "application/json",
      error,
      relationships: {
        root: run.rootTaskRun
          ? {
              ...run.rootTaskRun,
              isParent: run.parentTaskRun?.friendlyId === run.rootTaskRun.friendlyId,
            }
          : undefined,
        parent: run.parentTaskRun ?? undefined,
      },
      context: JSON.stringify(context, null, 2),
      metadata,
      maxDurationInSeconds: getMaxDuration(run.maxDurationInSeconds),
      batch: run.batch ? { friendlyId: run.batch.friendlyId } : undefined,
    };
  }

  async getSpan(runFriendlyId: string, spanId: string) {
    const run = await this._prisma.taskRun.findFirst({
      select: {
        traceId: true,
      },
      where: {
        friendlyId: runFriendlyId,
      },
    });

    if (!run) {
      return;
    }

    const span = await eventRepository.getSpan(spanId, run.traceId);

    if (!span) {
      return;
    }

    const triggeredRuns = await this._replica.taskRun.findMany({
      select: {
        friendlyId: true,
        taskIdentifier: true,
        spanId: true,
        createdAt: true,
        number: true,
        lockedToVersion: {
          select: {
            version: true,
          },
        },
      },
      where: {
        parentSpanId: spanId,
      },
    });

    return {
      ...span,
      events: span.events,
      properties: span.properties ? JSON.stringify(span.properties, null, 2) : undefined,
      triggeredRuns,
      showActionBar: span.show?.actions === true,
    };
  }
}
