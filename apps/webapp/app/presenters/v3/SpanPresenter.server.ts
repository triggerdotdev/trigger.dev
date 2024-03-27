import { prettyPrintPacket } from "@trigger.dev/core/v3";
import { PrismaClient, prisma } from "~/db.server";
import { eventRepository } from "~/v3/eventRepository.server";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = NonNullable<Result>["event"];

export class SpanPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    spanId,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    spanId: string;
  }) {
    const project = await this.#prismaClient.project.findUnique({
      where: {
        slug: projectSlug,
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const span = await eventRepository.getSpan(spanId);

    if (!span) {
      return;
    }

    const output =
      span.outputType === "application/store"
        ? `/resources/packets/${span.environmentId}/${span.output}`
        : typeof span.output !== "undefined" && span.output !== null
        ? prettyPrintPacket(span.output, span.outputType ?? undefined)
        : undefined;

    const payload =
      span.payloadType === "application/store"
        ? `/resources/packets/${span.environmentId}/${span.payload}`
        : typeof span.payload !== "undefined" && span.payload !== null
        ? prettyPrintPacket(span.payload, span.payloadType ?? undefined)
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
