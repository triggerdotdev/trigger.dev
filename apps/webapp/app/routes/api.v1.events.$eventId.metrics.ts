import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { parseEventRateLimitConfig } from "~/v3/services/events/eventRateLimiter.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (_resource, params) => ({ tasks: params.eventId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
    findResource: async () => 1 as const,
  },
  async ({ params, authentication }) => {
    const environment = authentication.environment;

    // Find event definition
    const eventDef = await prisma.eventDefinition.findFirst({
      where: {
        slug: params.eventId,
        projectId: environment.projectId,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!eventDef) {
      return json({ error: `Event "${params.eventId}" not found` }, { status: 404 });
    }

    // Get subscribers
    const subscriptions = await prisma.eventSubscription.findMany({
      where: {
        eventDefinitionId: eventDef.id,
        environmentId: environment.id,
      },
      select: {
        taskSlug: true,
        enabled: true,
        rateLimit: true,
        filter: true,
        consumerGroup: true,
      },
    });

    const activeCount = subscriptions.filter((s) => s.enabled).length;
    const disabledCount = subscriptions.length - activeCount;

    // Get DLQ counts
    const [pendingCount, retriedCount, discardedCount] = await Promise.all([
      prisma.deadLetterEvent.count({
        where: {
          eventType: params.eventId,
          projectId: environment.projectId,
          environmentId: environment.id,
          status: "PENDING",
        },
      }),
      prisma.deadLetterEvent.count({
        where: {
          eventType: params.eventId,
          projectId: environment.projectId,
          environmentId: environment.id,
          status: "RETRIED",
        },
      }),
      prisma.deadLetterEvent.count({
        where: {
          eventType: params.eventId,
          projectId: environment.projectId,
          environmentId: environment.id,
          status: "DISCARDED",
        },
      }),
    ]);

    // Parse rate limit config
    const rateLimitConfig = parseEventRateLimitConfig(eventDef.rateLimit);

    return json({
      eventType: params.eventId,
      subscribers: {
        total: subscriptions.length,
        active: activeCount,
        disabled: disabledCount,
        list: subscriptions.map((s) => ({
          taskSlug: s.taskSlug,
          enabled: s.enabled,
          hasRateLimit: !!s.rateLimit,
          hasFilter: !!s.filter,
          consumerGroup: s.consumerGroup,
        })),
      },
      dlq: {
        pending: pendingCount,
        retried: retriedCount,
        discarded: discardedCount,
      },
      rateLimit: rateLimitConfig
        ? { limit: rateLimitConfig.limit, window: rateLimitConfig.window }
        : null,
    });
  }
);
