import type { PatAuthResult } from "@trigger.dev/plugins";
import { personalAccessTokenExpiry, personalAccessTokenExpiryMessage } from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";

/**
 * The host's recheck of a plugin's PAT result. The plugin rejects expired tokens itself; this
 * makes sure a plugin built before expiry existed can't accept one. Such a plugin returns no
 * `expiresAt`, so the host reads it.
 */
export async function rejectExpiredPersonalAccessToken(
  result: PatAuthResult,
  replica: PrismaClient,
  now: Date = new Date()
): Promise<PatAuthResult> {
  if (!result.ok) return result;

  let expiresAt: Date | null;
  if (result.expiresAt === undefined) {
    const token = await replica.personalAccessToken.findFirst({
      where: { id: result.tokenId },
      select: { expiresAt: true },
    });
    // If the host can't read the token's expiry, fail closed.
    if (!token) {
      return { ok: false, status: 401, error: "Invalid PAT" };
    }
    expiresAt = token.expiresAt;
  } else {
    expiresAt = result.expiresAt;
  }

  const expiry = personalAccessTokenExpiry({ expiresAt }, now);
  if (expiry) {
    return {
      ok: false,
      status: 401,
      error: personalAccessTokenExpiryMessage(expiry),
      ...expiry,
    };
  }
  return { ...result, expiresAt };
}
