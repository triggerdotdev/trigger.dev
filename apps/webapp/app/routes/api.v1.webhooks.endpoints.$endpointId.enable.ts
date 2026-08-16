import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { webhookPrisma } from "~/db.server";
import { findWebhookEndpointResource } from "~/presenters/v3/ApiWebhookEndpointPresenter.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({ endpointId: z.string() });

// POST /api/v1/webhooks/endpoints/:endpointId/enable — resume a paused endpoint.
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
    const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
      where: { friendlyId: params.endpointId, runtimeEnvironmentId: env.id },
    });
    if (!endpoint) return json({ error: "Not found" }, { status: 404 });

    await webhookPrisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status: "ACTIVE", manuallyDeactivatedAt: null },
    });

    return json(await findWebhookEndpointResource(authentication, params.endpointId));
  }
);

export { action, loader };
