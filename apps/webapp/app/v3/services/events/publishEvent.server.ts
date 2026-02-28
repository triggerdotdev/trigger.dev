import { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
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

export class PublishEventService extends BaseService {
  private readonly _triggerFn: TriggerFn;

  constructor(
    prisma?: PrismaClientOrTransaction,
    triggerFn?: TriggerFn
  ) {
    super(prisma);
    this._triggerFn =
      triggerFn ??
      ((taskId, environment, body, options) => {
        const svc = new TriggerTaskService({ prisma: this._prisma });
        return svc.call(taskId, environment, body, options);
      });
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

      // 3. Find all active subscriptions for this event + environment
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

      // 4. Fan out: trigger each subscribed task
      const eventId = generateFriendlyId("evt");
      const runs: PublishEventResult["runs"] = [];

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

      return { eventId, runs };
    });
  }
}
