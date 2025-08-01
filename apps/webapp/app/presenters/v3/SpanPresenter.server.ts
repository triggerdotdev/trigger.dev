import {
  MachinePreset,
  prettyPrintPacket,
  SemanticInternalAttributes,
  TaskRunContext,
  TaskRunError,
  TriggerTraceContext,
  V3TaskRunContext,
} from "@trigger.dev/core/v3";
import { AttemptId, getMaxDuration, parseTraceparent } from "@trigger.dev/core/v3/isomorphic";
import { RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { logger } from "~/services/logger.server";
import { eventRepository, rehydrateAttribute } from "~/v3/eventRepository.server";
import { machinePresetFromRun } from "~/v3/machinePresets.server";
import { getTaskEventStoreTableForRun, type TaskEventStoreTable } from "~/v3/taskEventStore.server";
import { isFailedRunStatus, isFinalRunStatus } from "~/v3/taskStatus";
import { BasePresenter } from "./basePresenter.server";
import { WaitpointPresenter } from "./WaitpointPresenter.server";
import { engine } from "~/v3/runEngine.server";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = NonNullable<NonNullable<Result>["span"]>;
export type SpanRun = NonNullable<NonNullable<Result>["run"]>;
type FindRunResult = NonNullable<
  Awaited<ReturnType<InstanceType<typeof SpanPresenter>["findRun"]>>
>;
type GetSpanResult = NonNullable<Awaited<ReturnType<(typeof eventRepository)["getSpan"]>>>;

export class SpanPresenter extends BasePresenter {
  public async call({
    projectSlug,
    spanId,
    runFriendlyId,
  }: {
    projectSlug: string;
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
        projectId: true,
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

    const run = await this.getRun({
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
      projectId: parentRun.projectId,
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

  async getRun({
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

    const run = await this.findRun({ span, spanId });

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

    const machine = run.machinePreset ? machinePresetFromRun(run) : undefined;

    const context = await this.#getTaskRunContext({ run, machine: machine ?? undefined });

    const externalTraceId = this.#getExternalTraceId(run.traceContext);

    return {
      id: run.id,
      friendlyId: run.friendlyId,
      status: run.status,
      statusReason: run.statusReason ?? undefined,
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
      runtime: run.lockedToVersion?.runtime,
      runtimeVersion: run.lockedToVersion?.runtimeVersion,
      isTest: run.isTest,
      replayedFromTaskRunFriendlyId: run.replayedFromTaskRunFriendlyId,
      environmentId: run.runtimeEnvironment.id,
      idempotencyKey: run.idempotencyKey,
      idempotencyKeyExpiresAt: run.idempotencyKeyExpiresAt,
      schedule: await this.resolveSchedule(run.scheduleId ?? undefined),
      queue: {
        name: run.queue,
        isCustomQueue: !run.queue.startsWith("task/"),
        concurrencyKey: run.concurrencyKey,
      },
      tags: run.runTags,
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
      workerQueue: run.workerQueue,
      spanId: run.spanId,
      isCached: !!span.originalRun,
      machinePreset: machine?.name,
      externalTraceId,
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

  async findRun({ span, spanId }: { span: GetSpanResult; spanId: string }) {
    const run = await this._replica.taskRun.findFirst({
      select: {
        id: true,
        spanId: true,
        traceId: true,
        traceContext: true,
        //metadata
        number: true,
        taskIdentifier: true,
        friendlyId: true,
        isTest: true,
        maxDurationInSeconds: true,
        taskEventStore: true,
        runTags: true,
        machinePreset: true,
        lockedToVersion: {
          select: {
            version: true,
            sdkVersion: true,
            runtime: true,
            runtimeVersion: true,
          },
        },
        engine: true,
        workerQueue: true,
        error: true,
        output: true,
        outputType: true,
        //status + duration
        status: true,
        statusReason: true,
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
        replayedFromTaskRunFriendlyId: true,
        attempts: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
          select: {
            number: true,
            status: true,
            createdAt: true,
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

    return run;
  }

  async #getSpan({
    eventStore,
    traceId,
    spanId,
    environmentId,
    projectId,
    createdAt,
    completedAt,
  }: {
    traceId: string;
    spanId: string;
    environmentId: string;
    projectId: string;
    eventStore: TaskEventStoreTable;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    const span = await eventRepository.getSpan(
      eventStore,
      spanId,
      traceId,
      createdAt,
      completedAt ?? undefined,
      { includeDebugLogs: true }
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
      case "waitpoint": {
        if (!span.entity.id) {
          logger.error(`SpanPresenter: No waitpoint id`, {
            spanId,
            waitpointFriendlyId: span.entity.id,
          });
          return { ...data, entity: null };
        }

        const presenter = new WaitpointPresenter();
        const waitpoint = await presenter.call({
          friendlyId: span.entity.id,
          environmentId,
          projectId,
        });

        if (!waitpoint) {
          logger.error(`SpanPresenter: Waitpoint not found`, {
            spanId,
            waitpointFriendlyId: span.entity.id,
          });
          return { ...data, entity: null };
        }

        return {
          ...data,
          entity: {
            type: "waitpoint" as const,
            object: waitpoint,
          },
        };
      }
      case "attempt": {
        const isWarmStart = rehydrateAttribute<boolean>(
          span.metadata,
          SemanticInternalAttributes.WARM_START
        );

        return {
          ...data,
          entity: {
            type: "attempt" as const,
            object: {
              isWarmStart,
            },
          },
        };
      }
      default:
        return { ...data, entity: null };
    }
  }

  async #getTaskRunContext({ run, machine }: { run: FindRunResult; machine?: MachinePreset }) {
    if (run.engine === "V1") {
      return this.#getV3TaskRunContext({ run, machine });
    } else {
      return this.#getV4TaskRunContext({ run });
    }
  }

  async #getV3TaskRunContext({
    run,
    machine,
  }: {
    run: FindRunResult;
    machine?: MachinePreset;
  }): Promise<V3TaskRunContext> {
    const attempt = run.attempts[0];

    const context = {
      attempt: attempt
        ? {
            id: attempt.friendlyId,
            number: attempt.number,
            status: attempt.status,
            startedAt: attempt.createdAt,
          }
        : {
            id: AttemptId.generate().friendlyId,
            number: 1,
            status: "PENDING" as const,
            startedAt: run.updatedAt,
          },
      task: {
        id: run.taskIdentifier,
        filePath: run.lockedBy?.filePath ?? "",
      },
      run: {
        id: run.friendlyId,
        createdAt: run.createdAt,
        tags: run.runTags,
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
        id: run.queue,
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
      machine,
    } satisfies V3TaskRunContext;

    return context;
  }

  async #getV4TaskRunContext({ run }: { run: FindRunResult }): Promise<TaskRunContext> {
    return engine.resolveTaskRunContext(run.id);
  }

  #getExternalTraceId(traceContext: unknown) {
    if (!traceContext) {
      return;
    }

    const parsedTraceContext = TriggerTraceContext.safeParse(traceContext);

    if (!parsedTraceContext.success) {
      return;
    }

    const externalTraceparent = parsedTraceContext.data.external?.traceparent;

    if (!externalTraceparent) {
      return;
    }

    const parsedTraceparent = parseTraceparent(externalTraceparent);

    return parsedTraceparent?.traceId;
  }
}
