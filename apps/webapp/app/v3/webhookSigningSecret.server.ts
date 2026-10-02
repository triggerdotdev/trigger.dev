import { randomBytes } from "node:crypto";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { prisma, webhookPrisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";

type SecretEndpoint = { id: string; verifierArtifact: unknown };

export function webhookSigningSecretKey(endpointId: string): string {
  return `webhook:signing-secret:${endpointId}`;
}

function isAsymmetricWebhookEndpoint(endpoint: SecretEndpoint): boolean {
  const parsed = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
  return parsed.success && "config" in parsed.data && parsed.data.config.scheme === "asymmetric";
}

/**
 * Stores a signing secret (or, for an asymmetric source, the provider's public key) in the shape the
 * engine's `resolveSigningSecret` reads, and points the endpoint at it.
 */
export async function storeWebhookSigningSecret(endpoint: SecretEndpoint, secret: string) {
  const key = webhookSigningSecretKey(endpoint.id);
  await getSecretStore("DATABASE", { prismaClient: prisma }).setSecret(key, { secret });
  await webhookPrisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { signingSecretKey: key },
  });
}

/** Mints and stores a new shared secret, replacing any existing one. Refused for asymmetric sources. */
export async function generateWebhookSigningSecret(
  endpoint: SecretEndpoint
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  if (isAsymmetricWebhookEndpoint(endpoint)) {
    return {
      ok: false,
      error: "Cannot generate a secret for an asymmetric endpoint; set its public key instead.",
    };
  }
  const secret = `whsec_${randomBytes(32).toString("hex")}`;
  await storeWebhookSigningSecret(endpoint, secret);
  return { ok: true, secret };
}
