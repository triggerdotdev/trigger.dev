import { EventRepository } from "~/v3/eventRepository.server";
import { TracedEventSpan, TraceEventConcern, TriggerTaskRequest } from "../types";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3/semanticInternalAttributes";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { TaskRun } from "@trigger.dev/database";

export class DefaultTraceEventsConcern implements TraceEventConcern {
  private readonly eventRepository: EventRepository;

  constructor(eventRepository: EventRepository) {
    this.eventRepository = eventRepository;
  }

  async traceRun<T>(
    request: TriggerTaskRequest,
    callback: (span: TracedEventSpan) => Promise<T>
  ): Promise<T> {
    return await this.eventRepository.traceEvent(
      request.taskId,
      {
        context: request.options?.traceContext,
        spanParentAsLink: request.options?.spanParentAsLink,
        parentAsLinkType: request.options?.parentAsLinkType,
        kind: "SERVER",
        environment: request.environment,
        taskSlug: request.taskId,
        attributes: {
          properties: {
            [SemanticInternalAttributes.SHOW_ACTIONS]: true,
          },
          style: {
            icon: request.options?.customIcon ?? "task",
          },
          runIsTest: request.body.options?.test ?? false,
          batchId: request.options?.batchId
            ? BatchId.toFriendlyId(request.options.batchId)
            : undefined,
          idempotencyKey: request.options?.idempotencyKey,
        },
        incomplete: true,
        immediate: true,
      },
      async (event, traceContext, traceparent) => {
        return await callback({
          traceId: event.traceId,
          spanId: event.spanId,
          traceContext,
          traceparent,
          setAttribute: (key, value) => event.setAttribute(key as any, value),
          failWithError: event.failWithError.bind(event),
        });
      }
    );
  }

  async traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan) => Promise<T>
  ): Promise<T> {
    const { existingRun, idempotencyKey, incomplete, isError } = options;

    return await this.eventRepository.traceEvent(
      `${request.taskId} (cached)`,
      {
        context: request.options?.traceContext,
        spanParentAsLink: request.options?.spanParentAsLink,
        parentAsLinkType: request.options?.parentAsLinkType,
        kind: "SERVER",
        environment: request.environment,
        taskSlug: request.taskId,
        attributes: {
          properties: {
            [SemanticInternalAttributes.SHOW_ACTIONS]: true,
            [SemanticInternalAttributes.ORIGINAL_RUN_ID]: existingRun.friendlyId,
          },
          style: {
            icon: "task-cached",
          },
          runIsTest: request.body.options?.test ?? false,
          batchId: request.options?.batchId
            ? BatchId.toFriendlyId(request.options.batchId)
            : undefined,
          idempotencyKey,
          runId: existingRun.friendlyId,
        },
        incomplete,
        isError,
        immediate: true,
      },
      async (event, traceContext, traceparent) => {
        //log a message
        await this.eventRepository.recordEvent(
          `There's an existing run for idempotencyKey: ${idempotencyKey}`,
          {
            taskSlug: request.taskId,
            environment: request.environment,
            attributes: {
              runId: existingRun.friendlyId,
            },
            context: request.options?.traceContext,
            parentId: event.spanId,
          }
        );

        return await callback({
          traceId: event.traceId,
          spanId: event.spanId,
          traceContext,
          traceparent,
          setAttribute: (key, value) => event.setAttribute(key as any, value),
          failWithError: event.failWithError.bind(event),
        });
      }
    );
  }
}
