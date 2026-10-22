import { randomBytes } from "node:crypto";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import { prisma, webhookPrisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { replaceStoredSigningSecret, StoredSigningSecret } from "./webhookSigningSecret";

type SecretEndpoint = { id: string; verifierArtifact: unknown };

type StoreOptions = { previousSecretTtlSeconds?: number };

type StoreResult = { previousSecretExpiresAt?: string };

export function webhookSigningSecretKey(endpointId: string): string {
  return `webhook:signing-secret:${endpointId}`;
}

function isAsymmetricWebhookEndpoint(endpoint: SecretEndpoint): boolean {
  const parsed = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
  return parsed.success && "config" in parsed.data && parsed.data.config.scheme === "asymmetric";
}

/**
 * Stores a signing secret (or, for an asymmetric source, the provider's public key) in the shape the
 * engine's `resolveSigningSecret` reads, and points the endpoint at it. With
 * `previousSecretTtlSeconds`, the secret it replaces keeps verifying deliveries for that long.
 */
export async function storeWebhookSigningSecret(
  endpoint: SecretEndpoint,
  secret: string,
  options: StoreOptions = {}
): Promise<StoreResult> {
  const key = webhookSigningSecretKey(endpoint.id);
  const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });
  const ttl = options.previousSecretTtlSeconds ?? 0;
  const existing = ttl > 0 ? await secretStore.getSecret(StoredSigningSecret, key) : undefined;
  const stored = replaceStoredSigningSecret(existing, secret, ttl, new Date());
  await secretStore.setSecret(key, stored);
  await webhookPrisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { signingSecretKey: key },
  });
  return stored.previous ? { previousSecretExpiresAt: stored.previous.expiresAt } : {};
}

/** Mints and stores a new shared secret, replacing any existing one. Refused for asymmetric sources. */
export async function generateWebhookSigningSecret(
  endpoint: SecretEndpoint,
  options: StoreOptions = {}
): Promise<({ ok: true; secret: string } & StoreResult) | { ok: false; error: string }> {
  if (isAsymmetricWebhookEndpoint(endpoint)) {
    return {
      ok: false,
      error: "Cannot generate a secret for an asymmetric endpoint; set its public key instead.",
    };
  }
  const secret = `whsec_${randomBytes(32).toString("hex")}`;
  const stored = await storeWebhookSigningSecret(endpoint, secret, options);
  return { ok: true, secret, ...stored };
}
