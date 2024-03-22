import { Attributes } from "@opentelemetry/api";
import {
  ExceptionEventProperties,
  SemanticInternalAttributes,
  SpanEvent,
  SpanEvents,
  correctErrorStackTrace,
  isExceptionSpanEvent,
} from "@trigger.dev/core/v3";
import { z } from "zod";
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
        output: span.output ? JSON.stringify(span.output, null, 2) : undefined,
        payload: span.payload ? JSON.stringify(span.payload, null, 2) : undefined,
        properties: span.properties ? JSON.stringify(span.properties, null, 2) : undefined,
        showActionBar: (span.properties?.show as any)?.actions === true,
      },
    };
  }
}
