import { json } from "@remix-run/server-runtime";
import { randomBytes } from "node:crypto";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma, webhookPrisma } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { webhookEngine } from "~/v3/webhookEngine.server";

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
    const env = authentication.environment;
    const endpoint = await webhookPrisma.webhookEndpoint.findFirst({
      where: { friendlyId: params.endpointId, runtimeEnvironmentId: env.id },
    });
    if (!endpoint) return json({ error: "Not found" }, { status: 404 });

    const parsed = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
    if (parsed.success && "config" in parsed.data && parsed.data.config.scheme === "asymmetric") {
      return json(
        {
          error: "Cannot generate a secret for an asymmetric endpoint; set its public key instead.",
        },
        { status: 400 }
      );
    }

    const secret = `whsec_${randomBytes(32).toString("hex")}`;
    const secretKey = `webhook:signing-secret:${endpoint.id}`;
    await getSecretStore("DATABASE", { prismaClient: prisma }).setSecret(secretKey, { secret });
    await webhookPrisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { signingSecretKey: secretKey },
    });
    // Drop the cached secret so verification uses the new one immediately on this instance.
    webhookEngine.invalidateEndpoint(endpoint.opaqueId);

    return json({ id: endpoint.friendlyId, secretSet: true as const, secret });
  }
);

export { action, loader };
