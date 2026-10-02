import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { webhookReplica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { env as serverEnv } from "~/env.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import { webhookEngine } from "~/v3/webhookEngine.server";

const ParamsSchema = z.object({ deliveryId: z.string() });
const SearchParamsSchema = z.object({ targetId: z.string().min(1).optional() });

/**
 * POST /api/v1/webhooks/deliveries/:deliveryId/replay[?targetId=] re-runs the delivery from its stored
 * event as a new delivery (the raw body isn't kept, so this re-triggers rather than re-verifies). Every
 * current subscriber of the endpoint is re-checked against its filter; `targetId` replays one
 * subscriber only, past its filter. A replay starts runs, so beyond `write:webhooks` it needs
 * `trigger` on the task behind every subscriber it will run, and `write` on sessions for a session
 * subscriber. The engine checks exactly the subscribers it runs, on the read that creates the replay.
 */
const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchParamsSchema,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "write", resource: () => ({ type: "webhooks" }) },
  },
  async ({ params, searchParams, authentication, ability }) => {
    if (serverEnv.WEBHOOK_ENABLED !== "1") return json({ error: "Not found" }, { status: 404 });
    const env = authentication.environment;

    // Resolve the friendly id to the internal (id, createdAt) the engine needs (ClickHouse -> PG).
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      env.organizationId,
      "standard"
    );
    const original = await webhookDeliveriesRepository({
      clickhouse,
      prisma: webhookReplica,
    }).getDelivery({
      organizationId: env.organizationId,
      projectId: env.project.id,
      environmentId: env.id,
      friendlyId: params.deliveryId,
    });
    if (!original) return json({ error: "Not found" }, { status: 404 });

    const result = await webhookEngine.replayDelivery({
      id: original.id,
      createdAt: original.createdAt,
      targetId: searchParams.targetId,
      authorize: (subscribers) =>
        subscribers.flatMap((subscriber) => {
          if (!ability.can("trigger", { type: "tasks", id: subscriber.taskId })) {
            return [subscriber.taskId];
          }
          if (subscriber.type === "session" && !ability.can("write", { type: "sessions" })) {
            return [`sessions (for ${subscriber.id})`];
          }
          return [];
        }),
    });

    switch (result.outcome) {
      case "forbidden":
        return json(
          {
            error: `Replaying this delivery needs permissions you don't have: ${[...new Set(result.denied)].join(", ")}`,
          },
          { status: 403 }
        );
      case "replayed":
        return json({ deliveryId: result.deliveryFriendlyId, replayedFrom: params.deliveryId });
      case "delivery_not_found":
      case "endpoint_not_found":
        return json({ error: "Not found" }, { status: 404 });
      case "target_not_found":
        return json(
          { error: `The endpoint has no subscriber "${searchParams.targetId}".` },
          { status: 404 }
        );
    }
  }
);

export { action, loader };
