import { SemanticInternalAttributes } from "@trigger.dev/core/v3/semanticInternalAttributes";
import { TaskRun } from "@trigger.dev/database";
import { IEventRepository } from "~/v3/eventRepository/eventRepository.types";
import { getEventRepository } from "~/v3/eventRepository/index.server";
import { TracedEventSpan, TraceEventConcern, TriggerTaskRequest } from "../types";

export class DefaultTraceEventsConcern implements TraceEventConcern {
  async #getEventRepository(
    request: TriggerTaskRequest,
    parentStore: string | undefined
  ): Promise<{ repository: IEventRepository; store: string }> {
    return await getEventRepository(
      request.environment.organization.featureFlags as Record<string, unknown>,
      parentStore
    );
  }

  async traceRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    const { repository, store } = await this.#getEventRepository(request, parentStore);

    return await repository.traceEvent(
      request.taskId,
      {
        context: request.options?.traceContext,
        spanParentAsLink: request.options?.spanParentAsLink,
        kind: "SERVER",
        environment: request.environment,
        taskSlug: request.taskId,
        attributes: {
          properties: {},
          style: {
            icon: request.options?.customIcon ?? "task",
          },
        },
        incomplete: true,
        immediate: true,
        startTime: request.options?.overrideCreatedAt
          ? BigInt(request.options.overrideCreatedAt.getTime()) * BigInt(1000000)
          : undefined,
      },
      async (event, traceContext, traceparent) => {
        return await callback(
          {
            traceId: event.traceId,
            spanId: event.spanId,
            traceContext,
            traceparent,
            setAttribute: (key, value) => event.setAttribute(key as any, value),
            failWithError: event.failWithError.bind(event),
          },
          store
        );
      }
    );
  }

  async traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    const { existingRun, idempotencyKey, incomplete, isError } = options;
    const { repository, store } = await this.#getEventRepository(request, parentStore);

    return await repository.traceEvent(
      `${request.taskId} (cached)`,
      {
        context: request.options?.traceContext,
        spanParentAsLink: request.options?.spanParentAsLink,
        kind: "SERVER",
        environment: request.environment,
        taskSlug: request.taskId,
        attributes: {
          properties: {
            [SemanticInternalAttributes.ORIGINAL_RUN_ID]: existingRun.friendlyId,
          },
          style: {
            icon: "task-cached",
          },
          runId: existingRun.friendlyId,
        },
        incomplete,
        isError,
        immediate: true,
      },
      async (event, traceContext, traceparent) => {
        //log a message
        await repository.recordEvent(
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

        return await callback(
          {
            traceId: event.traceId,
            spanId: event.spanId,
            traceContext,
            traceparent,
            setAttribute: (key, value) => event.setAttribute(key as any, value),
            failWithError: event.failWithError.bind(event),
          },
          store
        );
      }
    );
  }
}
