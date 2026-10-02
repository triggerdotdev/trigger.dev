import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { webhookPrisma } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generateWebhookSigningSecret } from "~/v3/webhookSigningSecret.server";

const ParamsSchema = z.object({ endpointId: z.string() });

// POST /api/v1/webhooks/endpoints/:endpointId/rotate-secret — mint a new signing secret and return
// it ONCE. Only for schemes we generate (hmac / shared-secret); asymmetric endpoints set a public key.
const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "write", resource: () => ({ type: "webhooks" }) },
  },
  async ({ params, authentication }) => {
    const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
      where: { friendlyId: params.endpointId, runtimeEnvironmentId: authentication.environment.id },
      select: { id: true, friendlyId: true, verifierArtifact: true },
    });
    if (!endpoint) return json({ error: "Not found" }, { status: 404 });

    const result = await generateWebhookSigningSecret(endpoint);
    if (!result.ok) return json({ error: result.error }, { status: 400 });

    return json({ id: endpoint.friendlyId, secretSet: true as const, secret: result.secret });
  }
);

export { action, loader };
