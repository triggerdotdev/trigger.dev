import { json } from "@remix-run/server-runtime";
import type { CancelWebhookWaiterResponseBody } from "@trigger.dev/core/v3";
import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { env } from "~/env.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { webhookEngine } from "~/v3/webhookEngine.server";

const ParamsSchema = z.object({ waiterId: z.string() });

/**
 * POST /api/v1/webhooks/waiters/:waiterId/cancel frees the waiter's slot and fails its wait. A waiter
 * a delivery already claimed answers `{ cancelled: false, reason: "too_late" }`, and its run resumes
 * with that delivery's event.
 */
const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "write",
      resource: (params) => ({ type: "waitpoints", id: params.waiterId }),
    },
  },
  async ({ params, authentication }) => {
    if (env.WEBHOOK_ENABLED !== "1") {
      return json({ error: "Waiter not found" }, { status: 404 });
    }

    const result = await webhookEngine.cancelWaiter({
      environmentId: authentication.environment.id,
      waiterId: params.waiterId,
    });

    switch (result.outcome) {
      case "cancelled":
        return json<CancelWebhookWaiterResponseBody>({ cancelled: true });
      case "too_late":
        return json<CancelWebhookWaiterResponseBody>({
          cancelled: false,
          reason: "too_late",
          deliveryId: WebhookDeliveryId.toFriendlyId(result.deliveryId),
        });
      case "not_found":
        return json({ error: "Waiter not found" }, { status: 404 });
    }
  }
);

export { action, loader };
