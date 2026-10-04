import { json } from "@remix-run/server-runtime";
import { SetWebhookEndpointSecretRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { webhookPrisma } from "~/db.server";
import { webhookEndpointLookup } from "~/v3/webhookEndpointLookup";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { storeWebhookSigningSecret } from "~/v3/webhookSigningSecret.server";

const ParamsSchema = z.object({ endpointId: z.string() });

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: SetWebhookEndpointSecretRequestBody,
    method: "PUT",
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "write", resource: () => ({ type: "webhooks" }) },
  },
  async ({ params, body, authentication }) => {
    const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
      where: webhookEndpointLookup(authentication.environment.id, params.endpointId),
      select: { id: true, friendlyId: true, verifierArtifact: true },
    });
    if (!endpoint) return json({ error: "Not found" }, { status: 404 });

    await storeWebhookSigningSecret(endpoint, body.secret);

    return json({ id: endpoint.friendlyId, secretSet: true as const });
  }
);

export { action, loader };
