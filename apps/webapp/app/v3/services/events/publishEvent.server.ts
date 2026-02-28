import { TriggerTaskRequestBody, eventFilterMatches, matchesPattern } from "@trigger.dev/core/v3";
import type { EventFilter } from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../../friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "../baseService.server";
import {
  TriggerTaskService,
  TriggerTaskServiceOptions,
  TriggerTaskServiceResult,
} from "../triggerTask.server";
import { SchemaRegistryService } from "./schemaRegistry.server";

export type PublishEventOptions = {
  idempotencyKey?: string;
  delay?: string | Date;
  tags?: string | string[];
  metadata?: unknown;
  context?: unknown;
};

export type PublishEventResult = {
  eventId: string;
  runs: Array<{
    taskIdentifier: string;
    runId: string;
  }>;
};

/** Interface for the trigger function used by PublishEventService */
export type TriggerFn = (
  taskId: string,
  environment: AuthenticatedEnvironment,
  body: TriggerTaskRequestBody,
  options: TriggerTaskServiceOptions
) => Promise<TriggerTaskServiceResult | undefined>;

/** Callback to persist a published event to an external log (e.g. ClickHouse) */
export type EventLogWriter = (entry: EventLogEntry) => void;

export type EventLogEntry = {
  eventId: string;
  eventType: string;
  payload: unknown;
  publishedAt: Date;
  environmentId: string;
  projectId: string;
  organizationId: string;
  idempotencyKey?: string;
  tags?: string[];
  metadata?: unknown;
  fanOutCount: number;
};

export class PublishEventService extends BaseService {
  private readonly _triggerFn: TriggerFn;
  private readonly _eventLogWriter?: EventLogWriter;

  constructor(
    prisma?: PrismaClientOrTransaction,
    triggerFn?: TriggerFn,
    eventLogWriter?: EventLogWriter
  ) {
    super(prisma);
    this._triggerFn =
      triggerFn ??
      ((taskId, environment, body, options) => {
        const svc = new TriggerTaskService({ prisma: this._prisma });
        return svc.call(taskId, environment, body, options);
      });
    this._eventLogWriter = eventLogWriter;
  }

  public async call(
    eventSlug: string,
    environment: AuthenticatedEnvironment,
    payload: unknown,
    options: PublishEventOptions = {}
  ): Promise<PublishEventResult> {
    return this.traceWithEnv("publishEvent", environment, async (span) => {
      span.setAttribute("eventSlug", eventSlug);

      // 1. Look up EventDefinition by slug + projectId
      const eventDefinition = await this._prisma.eventDefinition.findFirst({
        where: {
          slug: eventSlug,
          projectId: environment.projectId,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (!eventDefinition) {
        throw new ServiceValidationError(`Event "${eventSlug}" not found`, 404);
      }

      span.setAttribute("eventDefinitionId", eventDefinition.id);

      // 2. Validate payload against stored schema (if exists)
      if (eventDefinition.schema) {
        const schemaRegistry = new SchemaRegistryService(this._prisma);
        const validation = schemaRegistry.validatePayload(
          eventDefinition.id,
          eventDefinition.schema,
          payload
        );

        if (!validation.success) {
          throw new ServiceValidationError(
            `Payload validation failed for event "${eventSlug}": ${validation.errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
            422
          );
        }
      }

      // 3. Find all active subscriptions: exact match + pattern-based
      const [exactSubscriptions, patternSubscriptions] = await Promise.all([
        // Exact subscriptions: tied to this specific EventDefinition
        this._prisma.eventSubscription.findMany({
          where: {
            eventDefinitionId: eventDefinition.id,
            environmentId: environment.id,
            enabled: true,
          },
        }),
        // Pattern subscriptions: have a wildcard pattern that might match this event slug
        this._prisma.eventSubscription.findMany({
          where: {
            projectId: environment.projectId,
            environmentId: environment.id,
            enabled: true,
            pattern: { not: null },
          },
        }),
      ]);

      // Filter pattern subscriptions: only keep those whose pattern matches the event slug
      const matchingPatternSubs = patternSubscriptions.filter((sub) => {
        if (!sub.pattern) return false;
        try {
          return matchesPattern(eventSlug, sub.pattern);
        } catch (error) {
          logger.warn("Failed to evaluate event pattern", {
            subscriptionId: sub.id,
            taskSlug: sub.taskSlug,
            pattern: sub.pattern,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      });

      // Deduplicate: if a subscription appears in both exact and pattern results, keep only once
      const seenIds = new Set(exactSubscriptions.map((s) => s.id));
      const dedupedPatternSubs = matchingPatternSubs.filter((s) => !seenIds.has(s.id));

      const subscriptions = [...exactSubscriptions, ...dedupedPatternSubs];

      span.setAttribute("subscriberCount", subscriptions.length);
      span.setAttribute("exactSubscriberCount", exactSubscriptions.length);
      span.setAttribute("patternSubscriberCount", dedupedPatternSubs.length);

      if (subscriptions.length === 0) {
        return {
          eventId: generateFriendlyId("evt"),
          runs: [],
        };
      }

      // 4. Evaluate content-based filters — skip subscribers whose filter doesn't match
      const matchingSubscriptions = subscriptions.filter((subscription) => {
        if (!subscription.filter) return true; // No filter → always matches

        try {
          return eventFilterMatches(payload, subscription.filter as EventFilter);
        } catch (error) {
          // Malformed filter → skip silently (don't block the publish)
          logger.warn("Failed to evaluate event filter", {
            subscriptionId: subscription.id,
            taskSlug: subscription.taskSlug,
            error: error instanceof Error ? error.message : String(error),
          });
          return true; // Err on the side of delivering
        }
      });

      const filteredCount = subscriptions.length - matchingSubscriptions.length;
      if (filteredCount > 0) {
        span.setAttribute("filteredOutCount", filteredCount);
      }
      span.setAttribute("matchingSubscriberCount", matchingSubscriptions.length);

      if (matchingSubscriptions.length === 0) {
        return {
          eventId: generateFriendlyId("evt"),
          runs: [],
        };
      }

      // 5. Fan out: trigger each matching subscribed task
      const eventId = generateFriendlyId("evt");
      const runs: PublishEventResult["runs"] = [];

      for (const subscription of matchingSubscriptions) {
        try {
          // Derive per-consumer idempotency key if a global one was provided
          const consumerIdempotencyKey = options.idempotencyKey
            ? `${options.idempotencyKey}:${subscription.taskSlug}`
            : undefined;

          // Merge event context into metadata so DLQ can identify event-triggered runs
          const eventMetadata = {
            ...(typeof options.metadata === "object" && options.metadata !== null
              ? (options.metadata as Record<string, unknown>)
              : {}),
            $$event: {
              eventId,
              eventType: eventSlug,
              sourceEventId: options.idempotencyKey
                ? `${options.idempotencyKey}`
                : undefined,
            },
          };

          const body: TriggerTaskRequestBody = {
            payload,
            context: options.context,
            options: {
              tags: options.tags
                ? Array.isArray(options.tags)
                  ? options.tags
                  : [options.tags]
                : undefined,
              metadata: eventMetadata,
              delay: options.delay,
            },
          };

          const triggerOptions: TriggerTaskServiceOptions = {
            idempotencyKey: consumerIdempotencyKey,
          };

          const result = await this._triggerFn(
            subscription.taskSlug,
            environment,
            body,
            triggerOptions
          );

          if (result) {
            runs.push({
              taskIdentifier: subscription.taskSlug,
              runId: result.run.friendlyId,
            });
          }
        } catch (error) {
          // Partial failure: log the error but continue with other subscribers
          logger.error("Failed to trigger task for event subscription", {
            eventSlug,
            eventId,
            taskSlug: subscription.taskSlug,
            subscriptionId: subscription.id,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
          });
        }
      }

      // 6. Persist to event log (async, non-blocking)
      if (this._eventLogWriter) {
        try {
          this._eventLogWriter({
            eventId,
            eventType: eventSlug,
            payload,
            publishedAt: new Date(),
            environmentId: environment.id,
            projectId: environment.projectId,
            organizationId: environment.organizationId,
            idempotencyKey: options.idempotencyKey,
            tags: options.tags
              ? Array.isArray(options.tags)
                ? options.tags
                : [options.tags]
              : undefined,
            metadata: options.metadata,
            fanOutCount: runs.length,
          });
        } catch (error) {
          logger.warn("Failed to write event to log", {
            eventId,
            eventSlug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { eventId, runs };
    });
  }
}
