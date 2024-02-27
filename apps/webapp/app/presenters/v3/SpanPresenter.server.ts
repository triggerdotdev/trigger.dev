import { Attributes } from "@opentelemetry/api";
import {
  SemanticInternalAttributes,
  TaskEventStyle,
  correctErrorStackTrace,
} from "@trigger.dev/core/v3";
import { unflattenAttributes } from "@trigger.dev/core/v3";
import { z } from "zod";
import { PrismaClient, prisma, Prisma } from "~/db.server";

type Result = Awaited<ReturnType<SpanPresenter["call"]>>;
export type Span = Result["event"];

const OtelExceptionProperty = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  stacktrace: z.string().optional(),
});

export type OtelExceptionProperty = z.infer<typeof OtelExceptionProperty>;

const OtelSpanEvent = z.object({
  name: z.string(),
  time: z.coerce.date(),
  properties: z
    .object({
      exception: OtelExceptionProperty.optional(),
    })
    .passthrough()
    .optional(),
});

const OtelSpanEvents = z.array(OtelSpanEvent).optional();
type OtelSpanEvents = z.infer<typeof OtelSpanEvents>;

export type OtelSpanEvent = z.infer<typeof OtelSpanEvent>;

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
    const matchingEvents = await this.#prismaClient.taskEvent.findMany({
      where: {
        spanId,
        projectId: project.id,
      },
    });

    const event =
      matchingEvents.length > 1
        ? matchingEvents.find((event) => !event.isPartial)
        : matchingEvents.at(0);
    if (!event) {
      throw new Error("Span not found");
    }

    const styleUnflattened = unflattenAttributes(event.style as Attributes);
    const style = TaskEventStyle.parse(styleUnflattened);

    const eventsUnflattened = event.events
      ? (event.events as any[]).map((e) => ({
          ...e,
          properties: unflattenAttributes(e.properties as Attributes),
        }))
      : undefined;

    const events = OtelSpanEvents.parse(eventsUnflattened);

    const payload = unflattenAttributes(
      filteredAttributes(event.properties as Attributes, SemanticInternalAttributes.PAYLOAD)
    )[SemanticInternalAttributes.PAYLOAD];

    return {
      event: {
        ...event,
        events: transformEvents(events, event.metadata as Attributes),
        output: isEmptyJson(event.output) ? null : JSON.stringify(event.output, null, 2),
        payload: payload ? JSON.stringify(payload, null, 2) : undefined,
        properties: sanitizedAttributesStringified(event.properties),
        style,
        duration: Number(event.duration),
      },
    };
  }
}

function transformEvents(events: OtelSpanEvents, properties: Attributes): OtelSpanEvents {
  return (events ?? []).map((event) => transformEvent(event, properties));
}

function transformEvent(event: OtelSpanEvent, properties: Attributes): OtelSpanEvent {
  if (!event.properties?.exception) {
    return event;
  }

  return {
    ...event,
    properties: {
      exception: transformException(event.properties.exception, properties),
    },
  };
}

function transformException(
  exception: OtelExceptionProperty,
  properties: Attributes
): OtelExceptionProperty {
  const projectDirAttributeValue = properties[SemanticInternalAttributes.PROJECT_DIR];

  if (typeof projectDirAttributeValue !== "string") {
    return exception;
  }

  return {
    ...exception,
    stacktrace: exception.stacktrace
      ? correctErrorStackTrace(exception.stacktrace, projectDirAttributeValue, {
          removeFirstLine: true,
        })
      : undefined,
  };
}

function filteredAttributes(attributes: Attributes, prefix: string): Attributes {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith(prefix)) {
      result[key] = value;
    }
  }

  return result;
}

function sanitizedAttributesStringified(json: Prisma.JsonValue): string | undefined {
  const sanitizedAttributesValue = sanitizedAttributes(json);
  if (!sanitizedAttributesValue) {
    return;
  }

  return JSON.stringify(sanitizedAttributesValue, null, 2);
}

function sanitizedAttributes(json: Prisma.JsonValue): Record<string, unknown> | undefined {
  if (json === null || json === undefined) {
    return;
  }

  const withoutPrivateProperties = removePrivateProperties(json as Attributes);
  if (!withoutPrivateProperties) {
    return;
  }

  return unflattenAttributes(withoutPrivateProperties);
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

// removes keys that start with a $ sign. If there are no keys left, return undefined
function removePrivateProperties(
  attributes: Attributes | undefined | null
): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("$")) {
      continue;
    }

    result[key] = value;
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result;
}
