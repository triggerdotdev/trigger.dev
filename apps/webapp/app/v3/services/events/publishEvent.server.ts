import { PublishEventResponseBody, TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../../friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "../baseService.server";
import {
  TriggerTaskService,
  TriggerTaskServiceOptions,
  TriggerTaskServiceResult,
} from "../triggerTask.server";

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

export class PublishEventService extends BaseService {
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

      // 2. Find all active subscriptions for this event + environment
      const subscriptions = await this._prisma.eventSubscription.findMany({
        where: {
          eventDefinitionId: eventDefinition.id,
          environmentId: environment.id,
          enabled: true,
        },
      });

      span.setAttribute("subscriberCount", subscriptions.length);

      if (subscriptions.length === 0) {
        return {
          eventId: generateFriendlyId("evt"),
          runs: [],
        };
      }

      // 3. Fan out: trigger each subscribed task
      const eventId = generateFriendlyId("evt");
      const runs: PublishEventResult["runs"] = [];

      const triggerService = new TriggerTaskService();

      for (const subscription of subscriptions) {
        try {
          // Derive per-consumer idempotency key if a global one was provided
          const consumerIdempotencyKey = options.idempotencyKey
            ? `${options.idempotencyKey}:${subscription.taskSlug}`
            : undefined;

          const body: TriggerTaskRequestBody = {
            payload,
            context: options.context,
            options: {
              tags: options.tags
                ? Array.isArray(options.tags)
                  ? options.tags
                  : [options.tags]
                : undefined,
              metadata: options.metadata,
              delay: options.delay,
            },
          };

          const triggerOptions: TriggerTaskServiceOptions = {
            idempotencyKey: consumerIdempotencyKey,
          };

          const result = await triggerService.call(
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

      return { eventId, runs };
    });
  }
}
