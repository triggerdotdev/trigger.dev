import { Attributes } from "@opentelemetry/api";
import { TaskEventStyle } from "@trigger.dev/core/v3";
import { unflattenAttributes } from "@trigger.dev/core/v3";
import { PrismaClient, prisma, Prisma } from "~/db.server";

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

    // Find the project scoped to the organization
    const events = await this.#prismaClient.taskEvent.findMany({
      where: {
        spanId,
        projectId: project.id,
      },
    });

    const event = events.length > 1 ? events.find((event) => !event.isPartial) : events.at(0);
    if (!event) {
      throw new Error("Span not found");
    }

    return {
      event: {
        ...event,
        output: isEmptyJson(event.output) ? null : JSON.stringify(event.output, null, 2),
        properties: event.properties
          ? JSON.stringify(unflattenAttributes(event.properties as Attributes), null, 2)
          : null,
        style: TaskEventStyle.parse(event.style),
        duration: Number(event.duration),
      },
    };
  }
}

function isEmptyJson(json: Prisma.JsonValue) {
  if (json === null) {
    return true;
  }
  if (Object.keys(json).length === 0) {
    return true;
  }

  return false;
}
