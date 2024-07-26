import { prettyPrintPacket } from "@trigger.dev/core/v3";
import { PrismaClient, prisma } from "~/db.server";
import { eventRepository } from "~/v3/eventRepository.server";
import { BasePresenter } from "./basePresenter.server";
import { FINISHED_STATUSES, RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = NonNullable<Result>["event"];
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

    const output =
      span.outputType === "application/store"
        ? `/resources/packets/${span.environmentId}/${span.output}`
        : typeof span.output !== "undefined"
        ? await prettyPrintPacket(span.output, span.outputType ?? undefined)
        : undefined;

    const payload =
      span.payloadType === "application/store"
        ? `/resources/packets/${span.environmentId}/${span.payload}`
        : typeof span.payload !== "undefined" && span.payload !== null
        ? await prettyPrintPacket(span.payload, span.payloadType ?? undefined)
        : undefined;

    //get the run
    const spanRun = await this._replica.taskRun.findFirst({
      select: {
        //metadata
        number: true,
        taskIdentifier: true,
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
          },
        },
      },
      where: {
        spanId: span.spanId,
      },
    });

    return {
      run: spanRun
        ? {
            ...spanRun,
            isFinished: FINISHED_STATUSES.includes(spanRun.status),
            isRunning: RUNNING_STATUSES.includes(spanRun.status),
          }
        : undefined,
      event: {
        ...span,
        events: span.events,
        output,
        outputType: span.outputType ?? "application/json",
        payload,
        payloadType: span.payloadType ?? "application/json",
        properties: span.properties ? JSON.stringify(span.properties, null, 2) : undefined,
        showActionBar: span.show?.actions === true,
      },
    };
  }
}
