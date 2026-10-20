import { z } from "zod";

export const MAX_PREVIOUS_SECRET_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long the replaced secret keeps verifying deliveries; 0 replaces it immediately. */
export const PreviousSecretTtlSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_PREVIOUS_SECRET_TTL_SECONDS);

/**
 * An endpoint's signing secret as stored in the SecretStore. `previous` is the secret it replaced,
 * still accepted until `expiresAt` so a rotation doesn't fail deliveries the provider signs with it.
 */
export const StoredSigningSecret = z.object({
  secret: z.string(),
  previous: z.object({ secret: z.string(), expiresAt: z.string() }).optional(),
});
export type StoredSigningSecret = z.infer<typeof StoredSigningSecret>;

export function replaceStoredSigningSecret(
  existing: StoredSigningSecret | undefined,
  secret: string,
  previousSecretTtlSeconds: number,
  now: Date
): StoredSigningSecret {
  if (existing?.secret === secret) {
    return previousSecretTtlSeconds > 0 && existing.previous
      ? { secret, previous: existing.previous }
      : { secret };
  }
  if (!existing?.secret || previousSecretTtlSeconds <= 0) return { secret };
  return {
    secret,
    previous: {
      secret: existing.secret,
      expiresAt: new Date(now.getTime() + previousSecretTtlSeconds * 1000).toISOString(),
    },
  };
}

/** The secrets ingest verifies against: the current one, then the previous one until it expires. */
export function activeSigningSecrets(stored: StoredSigningSecret | undefined, now: Date): string[] {
  if (!stored?.secret) return [];
  const previous = stored.previous;
  if (
    previous?.secret &&
    previous.secret !== stored.secret &&
    Date.parse(previous.expiresAt) > now.getTime()
  ) {
    return [stored.secret, previous.secret];
  }
  return [stored.secret];
}
