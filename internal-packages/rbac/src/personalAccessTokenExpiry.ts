import type { PatAuthResult, PersonalAccessTokenExpiryFields } from "@trigger.dev/plugins";
import { personalAccessTokenExpiry, personalAccessTokenExpiryMessage } from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";

/**
 * The host's recheck of a plugin's PAT result. The plugin rejects expired tokens itself; this
 * makes sure a plugin built before an expiry rule existed can't accept one. Such a plugin
 * doesn't return every expiry column, so the host reads them.
 */
export async function rejectExpiredPersonalAccessToken(
  result: PatAuthResult,
  replica: PrismaClient,
  now: Date = new Date()
): Promise<PatAuthResult> {
  if (!result.ok) return result;

  let fields: PersonalAccessTokenExpiryFields | null;
  if (
    result.expiresAt === undefined ||
    result.idleTimeoutSeconds === undefined ||
    result.createdAt === undefined
  ) {
    fields = await replica.personalAccessToken.findFirst({
      where: { id: result.tokenId },
      select: { expiresAt: true, idleTimeoutSeconds: true, lastAccessedAt: true, createdAt: true },
    });
  } else {
    fields = {
      expiresAt: result.expiresAt,
      idleTimeoutSeconds: result.idleTimeoutSeconds,
      lastAccessedAt: result.lastAccessedAt,
      createdAt: result.createdAt,
    };
  }

  // If the host can't read the token's expiry, fail closed.
  if (!fields) {
    return { ok: false, status: 401, error: "Invalid PAT" };
  }

  const expiry = personalAccessTokenExpiry(fields, now);
  if (expiry) {
    return {
      ok: false,
      status: 401,
      error: personalAccessTokenExpiryMessage(expiry),
      ...expiry,
    };
  }
  return {
    ...result,
    expiresAt: fields.expiresAt,
    idleTimeoutSeconds: fields.idleTimeoutSeconds,
    createdAt: fields.createdAt,
  };
}
