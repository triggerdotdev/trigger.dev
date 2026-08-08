import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { webhookReplica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import { webhookEngine } from "~/v3/webhookEngine.server";

const ParamsSchema = z.object({ deliveryId: z.string() });

// POST /api/v1/webhooks/deliveries/:deliveryId/replay — re-run the delivery's task from its stored
// event as a NEW delivery (we don't keep the raw body, so this re-triggers rather than re-verifies).
const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "write", resource: () => ({ type: "webhooks" }) },
  },
  async ({ params, authentication }) => {
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
    });

    switch (result.outcome) {
      case "replayed":
        return json({ deliveryId: result.deliveryFriendlyId, replayedFrom: params.deliveryId });
      case "delivery_not_found":
      case "endpoint_not_found":
        return json({ error: "Not found" }, { status: 404 });
      case "unsupported_target":
        return json(
          { error: "This delivery's endpoint does not route to a task." },
          { status: 400 }
        );
    }
  }
);

export { action, loader };
