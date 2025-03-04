import {
  isWaitpointOutputTimeout,
  MachinePresetName,
  parsePacket,
  prettyPrintPacket,
  SemanticInternalAttributes,
  TaskRunError,
} from "@trigger.dev/core/v3";
import { RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { eventRepository } from "~/v3/eventRepository.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { FINAL_ATTEMPT_STATUSES, isFailedRunStatus, isFinalRunStatus } from "~/v3/taskStatus";
import { BasePresenter } from "./basePresenter.server";
import { getMaxDuration } from "@trigger.dev/core/v3/apps";
import { logger } from "~/services/logger.server";
import { getTaskEventStoreTableForRun, TaskEventStoreTable } from "~/v3/taskEventStore.server";
import { Pi } from "lucide-react";

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
    const project = await this._replica.project.findFirst({
      where: {
        slug: projectSlug,
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const parentRun = await this._prisma.taskRun.findFirst({
      select: {
        traceId: true,
        runtimeEnvironmentId: true,
        taskEventStore: true,
        createdAt: true,
        completedAt: true,
      },
      where: {
        friendlyId: runFriendlyId,
      },
    });

    if (!parentRun) {
      return;
    }

    const { traceId } = parentRun;

    const eventStore = getTaskEventStoreTableForRun(parentRun);

    const run = await this.#getRun({
      eventStore,
      traceId,
      spanId,
      createdAt: parentRun.createdAt,
      completedAt: parentRun.completedAt,
    });
    if (run) {
      return {
        type: "run" as const,
        run,
      };
    }

    //get the run
    const span = await this.#getSpan({
      eventStore,
      traceId,
      spanId,
      environmentId: parentRun.runtimeEnvironmentId,
      createdAt: parentRun.createdAt,
      completedAt: parentRun.completedAt,
    });

    if (!span) {
      throw new Error("Span not found");
    }

    return {
      type: "span" as const,
      span,
    };
  }

  async #getRun({
    eventStore,
    traceId,
    spanId,
    createdAt,
    completedAt,
  }: {
    eventStore: TaskEventStoreTable;
    traceId: string;
    spanId: string;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    const span = await eventRepository.getSpan(
      eventStore,
      spanId,
      traceId,
      createdAt,
      completedAt ?? undefined
    );

    if (!span) {
      return;
    }

    const run = await this._replica.taskRun.findFirst({
      select: {
        id: true,
        spanId: true,
        traceId: true,
        //metadata
        number: true,
        taskIdentifier: true,
        friendlyId: true,
        isTest: true,
        maxDurationInSeconds: true,
        taskEventStore: true,
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
        engine: true,
        masterQueue: true,
        secondaryMasterQueue: true,
        error: true,
        output: true,
        outputType: true,
        //status + duration
        status: true,
        startedAt: true,
        executedAt: true,
        createdAt: true,
        updatedAt: true,
        queuedAt: true,
        completedAt: true,
        logsDeletedAt: true,
        //idempotency
        idempotencyKey: true,
        idempotencyKeyExpiresAt: true,
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
            exportName: true,
          },
        },
        //relationships
        rootTaskRun: {
          select: {
            taskIdentifier: true,
            friendlyId: true,
            spanId: true,
            createdAt: true,
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
      where: span.originalRun
        ? {
            friendlyId: span.originalRun,
          }
        : {
            spanId,
          },
    });

    if (!run) {
      return;
    }

    const isFinished = isFinalRunStatus(run.status);
    const output = !isFinished
      ? undefined
      : run.outputType === "application/store"
      ? `/resources/packets/${run.runtimeEnvironment.id}/${run.output}`
      : typeof run.output !== "undefined" && run.output !== null
      ? await prettyPrintPacket(run.output, run.outputType ?? undefined)
      : undefined;

    const payload =
      run.payloadType === "application/store"
        ? `/resources/packets/${run.runtimeEnvironment.id}/${run.payload}`
        : typeof run.payload !== "undefined" && run.payload !== null
        ? await prettyPrintPacket(run.payload, run.payloadType ?? undefined)
        : undefined;

    let error: TaskRunError | undefined = undefined;

    if (run?.error) {
      const result = TaskRunError.safeParse(run.error);
      if (result.success) {
        error = result.data;
      } else {
        error = {
          type: "CUSTOM_ERROR",
          raw: JSON.stringify(run.error),
        };
      }
    }

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
      executedAt: run.executedAt,
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
      idempotencyKey: run.idempotencyKey,
      idempotencyKeyExpiresAt: run.idempotencyKeyExpiresAt,
      schedule: await this.resolveSchedule(run.scheduleId ?? undefined),
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
      outputType: run?.outputType ?? "application/json",
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
      engine: run.engine,
      masterQueue: run.masterQueue,
      secondaryMasterQueue: run.secondaryMasterQueue,
      spanId: run.spanId,
      isCached: !!span.originalRun,
    };
  }

  async resolveSchedule(scheduleId?: string) {
    if (!scheduleId) {
      return;
    }

    const schedule = await this._replica.taskSchedule.findFirst({
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

  async #getSpan({
    eventStore,
    traceId,
    spanId,
    environmentId,
    createdAt,
    completedAt,
  }: {
    traceId: string;
    spanId: string;
    environmentId: string;
    eventStore: TaskEventStoreTable;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    const span = await eventRepository.getSpan(
      eventStore,
      spanId,
      traceId,
      createdAt,
      completedAt ?? undefined
    );
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

    const data = {
      ...span,
      events: span.events,
      properties: span.properties ? JSON.stringify(span.properties, null, 2) : undefined,
      triggeredRuns,
      showActionBar: span.show?.actions === true,
    };

    switch (span.entity.type) {
      case "waitpoint":
        const waitpoint = await this._replica.waitpoint.findFirst({
          where: {
            friendlyId: span.entity.id,
          },
          select: {
            friendlyId: true,
            type: true,
            status: true,
            idempotencyKey: true,
            userProvidedIdempotencyKey: true,
            idempotencyKeyExpiresAt: true,
            output: true,
            outputType: true,
            outputIsError: true,
            completedAfter: true,
          },
        });

        if (!waitpoint) {
          logger.error(`SpanPresenter: Waitpoint not found`, {
            spanId,
            waitpointFriendlyId: span.entity.id,
          });
          return { ...data, entity: null };
        }

        const output =
          waitpoint.outputType === "application/store"
            ? `/resources/packets/${environmentId}/${waitpoint.output}`
            : typeof waitpoint.output !== "undefined" && waitpoint.output !== null
            ? await prettyPrintPacket(waitpoint.output, waitpoint.outputType ?? undefined)
            : undefined;

        let isTimeout = false;
        if (waitpoint.outputIsError && output) {
          if (isWaitpointOutputTimeout(output)) {
            isTimeout = true;
          }
        }

        return {
          ...data,
          entity: {
            type: "waitpoint" as const,
            object: {
              friendlyId: waitpoint.friendlyId,
              type: waitpoint.type,
              status: waitpoint.status,
              idempotencyKey: waitpoint.idempotencyKey,
              userProvidedIdempotencyKey: waitpoint.userProvidedIdempotencyKey,
              idempotencyKeyExpiresAt: waitpoint.idempotencyKeyExpiresAt,
              output: output,
              outputType: waitpoint.outputType,
              outputIsError: waitpoint.outputIsError,
              completedAfter: waitpoint.completedAfter,
              isTimeout,
            },
          },
        };

      default:
        return { ...data, entity: null };
    }
  }
}
