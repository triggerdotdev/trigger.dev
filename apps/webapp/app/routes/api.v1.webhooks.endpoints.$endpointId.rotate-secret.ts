import { json } from "@remix-run/server-runtime";
import { RotateWebhookEndpointSecretRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { webhookPrisma } from "~/db.server";
import { webhookEndpointLookup } from "~/v3/webhookEndpointLookup";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { safeJsonParse } from "~/utils/json";
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
  async ({ params, authentication, request }) => {
    const rawBody = await request.text();
    const body = RotateWebhookEndpointSecretRequestBody.safeParse(
      rawBody ? safeJsonParse(rawBody) : {}
    );
    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
      where: webhookEndpointLookup(authentication.environment.id, params.endpointId),
      select: { id: true, friendlyId: true, verifierArtifact: true },
    });
    if (!endpoint) return json({ error: "Not found" }, { status: 404 });

    const result = await generateWebhookSigningSecret(endpoint, body.data);
    if (!result.ok) return json({ error: result.error }, { status: 400 });

    return json({
      id: endpoint.friendlyId,
      secretSet: true as const,
      secret: result.secret,
      previousSecretExpiresAt: result.previousSecretExpiresAt,
    });
  }
);

export { action, loader };
