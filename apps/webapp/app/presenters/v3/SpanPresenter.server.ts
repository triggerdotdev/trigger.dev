import { prettyPrintPacket } from '@trigger.dev/core/v3/utils/ioSerialization';
import { PrismaClient, prisma } from "~/db.server";
import { eventRepository } from "~/v3/eventRepository.server";
import { BasePresenter } from "./basePresenter.server";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = NonNullable<Result>["event"];

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

    return {
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
