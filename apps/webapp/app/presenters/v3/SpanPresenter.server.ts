import { Context, MachinePresetName, prettyPrintPacket } from "@trigger.dev/core/v3";
import { FINISHED_STATUSES, RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { eventRepository } from "~/v3/eventRepository.server";
import { BasePresenter } from "./basePresenter.server";
import { machineDefinition } from "@trigger.dev/platform/v3";
import { machinePresetFromName } from "~/v3/machinePresets.server";

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
        maxAttempts: true,
        //finished attempt
        attempts: {
          select: {
            output: true,
            outputType: true,
            error: true,
          },
          where: {
            status: "COMPLETED",
          },
        },
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
      },
      where: {
        spanId,
      },
    });

    if (!run) {
      return;
    }

    const finishedAttempt = run.attempts.at(0);
    const output =
      finishedAttempt === undefined
        ? undefined
        : finishedAttempt.outputType === "application/store"
        ? `/resources/packets/${run.runtimeEnvironment.id}/${finishedAttempt.output}`
        : typeof finishedAttempt.output !== "undefined"
        ? await prettyPrintPacket(finishedAttempt.output, finishedAttempt.outputType ?? undefined)
        : undefined;

    const payload =
      run.payloadType === "application/store"
        ? `/resources/packets/${run.runtimeEnvironment.id}/${run.payload}`
        : typeof run.payload !== "undefined" && run.payload !== null
        ? await prettyPrintPacket(run.payload, run.payloadType ?? undefined)
        : undefined;

    const span = await eventRepository.getSpan(spanId, run.traceId);

    const context = {
      task: {
        id: run.taskIdentifier,
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
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      delayUntil: run.delayUntil,
      expiredAt: run.expiredAt,
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
      isFinished: FINISHED_STATUSES.includes(run.status),
      isRunning: RUNNING_STATUSES.includes(run.status),
      payload,
      payloadType: run.payloadType,
      output,
      outputType: finishedAttempt?.outputType ?? "application/json",
      links: span?.links,
      events: span?.events,
      context: JSON.stringify(context, null, 2),
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

    return {
      ...span,
      events: span.events,
      properties: span.properties ? JSON.stringify(span.properties, null, 2) : undefined,
      showActionBar: span.show?.actions === true,
    };
  }
}
