import { createHash, randomBytes } from "node:crypto";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import {
  Prisma,
  type PrismaClientOrTransaction,
  type PrismaTransactionClient,
} from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma, webhookPrisma } from "~/db.server";
import { getSecretStore, type SecretStore } from "~/services/secrets/secretStore.server";
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

type SecretDeps = {
  /** The database the secret store lives in. */
  prisma: PrismaClientOrTransaction;
  /** The database the webhook tables live in: the same client as `prisma` on a single-database install. */
  webhookPrisma: PrismaClientOrTransaction;
  secretStoreFor: (client: PrismaClientOrTransaction) => SecretStore;
};

function defaultSecretDeps(): SecretDeps {
  return {
    prisma,
    // A PrismaClient at runtime; its WebhookDatabase type only narrows what the engine may call.
    webhookPrisma: webhookPrisma as unknown as PrismaClientOrTransaction,
    secretStoreFor: (client) => getSecretStore("DATABASE", { prismaClient: client }),
  };
}

type LockedClients = {
  endpoints: PrismaTransactionClient["webhookEndpoint"];
  secretStore: SecretStore;
};

/**
 * Runs `fn` holding the endpoint's signing-secret lock, so set, rotate, capture and clear never
 * interleave. The secret lives in the secret store and the endpoint's pointer to it in the webhook
 * tables, which can be separate databases; a transaction-scoped advisory lock on the webhook
 * database serializes the writers, and is released if the process dies. When both share one
 * database, the secret-store writes run on the lock's own transaction, so they need no second
 * connection from the same pool and the secret and pointer change atomically.
 */
async function withSigningSecretLock<T>(
  deps: SecretDeps,
  endpointId: string,
  name: string,
  fn: (clients: LockedClients) => Promise<T>
): Promise<T> {
  const result = await $transaction(
    deps.webhookPrisma,
    `webhookSigningSecret.${name}`,
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`webhook-signing-secret:${endpointId}`}, 0))::text`;
      const secretStore = deps.secretStoreFor(
        deps.webhookPrisma === deps.prisma ? tx : deps.prisma
      );
      return { value: await fn({ endpoints: tx.webhookEndpoint, secretStore }) };
    },
    { timeout: 15_000 }
  );
  if (!result) throw new Error(`webhook signing secret ${name} did not complete`);
  return result.value;
}

/**
 * Stores a signing secret (or, for an asymmetric source, the provider's public key) in the shape the
 * engine's `resolveSigningSecret` reads, and points the endpoint at it. With
 * `previousSecretTtlSeconds`, the secret it replaces keeps verifying deliveries for that long.
 */
export async function storeWebhookSigningSecret(
  endpoint: SecretEndpoint,
  secret: string,
  options: StoreOptions = {},
  deps: SecretDeps = defaultSecretDeps()
): Promise<StoreResult> {
  const key = webhookSigningSecretKey(endpoint.id);
  return withSigningSecretLock(deps, endpoint.id, "store", async ({ endpoints, secretStore }) => {
    const ttl = options.previousSecretTtlSeconds ?? 0;
    const existing = ttl > 0 ? await secretStore.getSecret(StoredSigningSecret, key) : undefined;
    const stored = replaceStoredSigningSecret(existing, secret, ttl, new Date());
    await secretStore.setSecret(key, stored);
    await endpoints.update({ where: { id: endpoint.id }, data: { signingSecretKey: key } });
    return stored.previous ? { previousSecretExpiresAt: stored.previous.expiresAt } : {};
  });
}

/** Marks a captured secret as hidden from the dashboard, by its hash, without touching the secret. */
const HiddenCapturedSecret = z.object({ sha256: z.string() });

function hiddenCapturedSecretKey(endpointId: string): string {
  return `webhook:captured-secret-hidden:${endpointId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Adopts a secret the provider sent in its unsigned verification request as the endpoint's signing
 * secret, only while the endpoint has none. The secret is written with an insert that fails when a
 * secret already exists, so it never replaces one that was set, and there is no claim to undo if the
 * process stops partway. Resolves true when this secret is the endpoint's signing secret: newly
 * stored, or already stored by an earlier attempt of the same request.
 */
export async function adoptCapturedWebhookSigningSecret(
  endpointId: string,
  secret: string,
  deps: SecretDeps = defaultSecretDeps()
): Promise<boolean> {
  const key = webhookSigningSecretKey(endpointId);
  return withSigningSecretLock(deps, endpointId, "adopt", async ({ endpoints, secretStore }) => {
    const stored: StoredSigningSecret = { secret, capturedAt: new Date().toISOString() };
    let adopted = await secretStore.createSecret(key, stored);
    if (!adopted) {
      const existing = await secretStore.getSecret(StoredSigningSecret, key);
      adopted = existing?.secret === secret;
    }
    // Point the endpoint at the key even when the insert lost: a secret stored there by an attempt
    // that stopped before this update must be the one deliveries verify against.
    await endpoints.updateMany({
      where: { id: endpointId, signingSecretKey: null },
      data: { signingSecretKey: key },
    });
    return adopted;
  });
}

/**
 * The secret the provider sent, while it is still the endpoint's signing secret and hasn't been
 * hidden. Any set, generate or rotate replaces the stored record without the capture marker.
 */
export async function capturedWebhookSigningSecret(
  endpointId: string,
  deps: Pick<SecretDeps, "prisma" | "secretStoreFor"> = defaultSecretDeps()
): Promise<{ secret: string; capturedAt: string } | null> {
  const secretStore = deps.secretStoreFor(deps.prisma);
  const stored = await secretStore.getSecret(
    StoredSigningSecret,
    webhookSigningSecretKey(endpointId)
  );
  if (!stored?.capturedAt) return null;
  const hidden = await secretStore.getSecret(
    HiddenCapturedSecret,
    hiddenCapturedSecretKey(endpointId)
  );
  if (hidden?.sha256 === sha256(stored.secret)) return null;
  return { secret: stored.secret, capturedAt: stored.capturedAt };
}

/**
 * Hides a captured secret from the dashboard once the user has pasted it into the provider. Writes a
 * separate marker rather than rewriting the signing secret, so it can't undo a concurrent rotation.
 */
export async function hideCapturedWebhookSigningSecret(
  endpointId: string,
  deps: Pick<SecretDeps, "prisma" | "secretStoreFor"> = defaultSecretDeps()
): Promise<void> {
  const captured = await capturedWebhookSigningSecret(endpointId, deps);
  if (!captured) return;
  await deps.secretStoreFor(deps.prisma).setSecret(hiddenCapturedSecretKey(endpointId), {
    sha256: sha256(captured.secret),
  });
}

/**
 * Removes the endpoint's signing secret, so deliveries are rejected until a new one is set, and a
 * source that captures its secret (Notion) stores the next verification token it sends. The secret
 * is deleted before the endpoint stops pointing at it, so an interruption leaves an endpoint that
 * rejects deliveries, and clearing again finishes the job.
 */
export async function clearWebhookSigningSecret(
  endpointId: string,
  deps: SecretDeps = defaultSecretDeps()
): Promise<void> {
  await withSigningSecretLock(deps, endpointId, "clear", async ({ endpoints, secretStore }) => {
    await deleteSecretIfPresent(secretStore, webhookSigningSecretKey(endpointId));
    await deleteSecretIfPresent(secretStore, hiddenCapturedSecretKey(endpointId));
    await endpoints.updateMany({ where: { id: endpointId }, data: { signingSecretKey: null } });
  });
}

async function deleteSecretIfPresent(secretStore: SecretStore, key: string): Promise<void> {
  try {
    await secretStore.deleteSecret(key);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return;
    throw error;
  }
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
