import { EventRepository } from "~/v3/eventRepository/eventRepository.server";
import { TracedEventSpan, TraceEventConcern, TriggerTaskRequest } from "../types";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3/semanticInternalAttributes";
import { TaskRun } from "@trigger.dev/database";
import { getTaskEventStore } from "~/v3/taskEventStore.server";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import { IEventRepository } from "~/v3/eventRepository/eventRepository.types";
import { FEATURE_FLAG, flags } from "~/v3/featureFlags.server";
import { env } from "~/env.server";
import { getEventRepository } from "~/v3/eventRepository/index.server";

export class DefaultTraceEventsConcern implements TraceEventConcern {
  private readonly eventRepository: EventRepository;
  private readonly clickhouseEventRepository: ClickhouseEventRepository;

  constructor(
    eventRepository: EventRepository,
    clickhouseEventRepository: ClickhouseEventRepository
  ) {
    this.eventRepository = eventRepository;
    this.clickhouseEventRepository = clickhouseEventRepository;
  }

  async #getEventRepository(
    request: TriggerTaskRequest
  ): Promise<{ repository: IEventRepository; store: string }> {
    return await getEventRepository(
      request.environment.organization.featureFlags as Record<string, unknown>
    );
  }

  async traceRun<T>(
    request: TriggerTaskRequest,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    const { repository, store } = await this.#getEventRepository(request);

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
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    const { existingRun, idempotencyKey, incomplete, isError } = options;
    const { repository, store } = await this.#getEventRepository(request);

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
