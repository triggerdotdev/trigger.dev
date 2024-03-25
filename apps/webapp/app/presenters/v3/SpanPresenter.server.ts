import { prettyPrintOutput } from "@trigger.dev/core/v3";
import { PrismaClient, prisma } from "~/db.server";
import { eventRepository } from "~/v3/eventRepository.server";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = Result["event"];

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
      throw new Error("Event not found");
    }

    return {
      event: {
        ...span,
        events: span.events,
        output: prettyPrintOutput(span.output, span.outputType ?? undefined),
        payload: span.payload ? JSON.stringify(span.payload, null, 2) : undefined,
        properties: span.properties ? JSON.stringify(span.properties, null, 2) : undefined,
        showActionBar: span.show?.actions === true,
      },
    };
  }
}
