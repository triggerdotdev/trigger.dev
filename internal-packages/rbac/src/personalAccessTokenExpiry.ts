import type { PatAuthResult, PersonalAccessTokenExpiryFields } from "@trigger.dev/plugins";
import { personalAccessTokenExpiry, personalAccessTokenExpiryMessage } from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import type { SealedIdCodec } from "./publicTokenSubject.js";

/**
 * Whether a personal access token can still be used: it exists, isn't revoked, and hasn't
 * expired or gone idle. Tokens derived from a PAT (user-actor tokens, env JWTs from the PAT
 * exchange) check their source here on every use, so revoking or expiring the PAT ends them.
 */
export async function isPersonalAccessTokenActive(
  db: Pick<PrismaClient, "personalAccessToken">,
  tokenId: string,
  now: Date = new Date()
): Promise<boolean> {
  const fields = await db.personalAccessToken.findFirst({
    where: { id: tokenId, revokedAt: null },
    select: { expiresAt: true, idleTimeoutSeconds: true, lastAccessedAt: true, createdAt: true },
  });
  return fields !== null && !personalAccessTokenExpiry(fields, now);
}

/**
 * The cached check's lookup. `missing` is kept apart from `inactive` because only `inactive` is
 * final: a missing row may just not have reached the replica yet, while revoked, expired and
 * idle tokens stay that way.
 */
async function personalAccessTokenStatus(
  db: Pick<PrismaClient, "personalAccessToken">,
  tokenId: string,
  now: Date
): Promise<"active" | "inactive" | "missing"> {
  const fields = await db.personalAccessToken.findFirst({
    where: { id: tokenId },
    select: {
      revokedAt: true,
      expiresAt: true,
      idleTimeoutSeconds: true,
      lastAccessedAt: true,
      createdAt: true,
    },
  });
  if (!fields) return "missing";
  return fields.revokedAt === null && !personalAccessTokenExpiry(fields, now)
    ? "active"
    : "inactive";
}

/**
 * The source PAT a public JWT names in `act.pat`, sealed so the raw id never appears in the
 * token. `undefined` when it names none (SDK public tokens, org-token exchanges, exchanges from
 * before the claim): there's nothing to check. `id` is undefined when the claim doesn't open
 * with `codec`, which a correctly signed token can only mean was sealed under another key, so
 * callers treat the token as ended.
 */
export function sourcePersonalAccessTokenClaim(
  payload: Record<string, unknown>,
  codec: SealedIdCodec | undefined
): { sealed: string; id: string | undefined } | undefined {
  const act = payload.act as { pat?: unknown } | undefined;
  if (typeof act?.pat !== "string" || act.pat.length === 0) return undefined;
  return { sealed: act.pat, id: codec?.decode(act.pat) };
}

/**
 * How long an env JWT's source PAT check is reused. A revocation lands within about this long
 * on each instance, plus replica lag (the check reads the replica).
 */
export const SOURCE_PAT_CHECK_TTL_MS = 60_000;

/**
 * `isPersonalAccessTokenActive` for the env JWT verifiers, cached per process. Public JWT
 * verification is a hot path (realtime, triggering), so a PAT's answer is reused for
 * `ttlMs`; revoking, expiring or idling it takes effect within that window. Inactive answers
 * are cached too (they're final, and it stops a dead JWT from costing a query per request),
 * but a missing row isn't: it may only be replica lag on a PAT created moments ago.
 */
export class SourcePersonalAccessTokenCheck {
  readonly #entries = new Map<string, { active: boolean; checkedAt: number }>();

  constructor(
    private readonly options: {
      ttlMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {}
  ) {}

  async isActive(db: Pick<PrismaClient, "personalAccessToken">, tokenId: string) {
    const ttlMs = this.options.ttlMs ?? SOURCE_PAT_CHECK_TTL_MS;
    const now = this.options.now?.() ?? Date.now();

    const cached = this.#entries.get(tokenId);
    if (cached && now - cached.checkedAt < ttlMs) return cached.active;

    const status = await personalAccessTokenStatus(db, tokenId, new Date(now));
    if (status === "missing") return false;

    const active = status === "active";
    this.#remember(tokenId, active, now, ttlMs);
    return active;
  }

  #remember(tokenId: string, active: boolean, now: number, ttlMs: number) {
    const maxEntries = this.options.maxEntries ?? 10_000;
    // Re-insert so the Map's order stays oldest-checked first.
    this.#entries.delete(tokenId);
    if (this.#entries.size >= maxEntries) {
      // Oldest first, so the expired entries are a prefix.
      for (const [id, entry] of this.#entries) {
        if (now - entry.checkedAt < ttlMs) break;
        this.#entries.delete(id);
      }
      if (this.#entries.size >= maxEntries) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
    }
    this.#entries.set(tokenId, { active, checkedAt: now });
  }
}

/** The process-wide check both env JWT verifiers share. */
export const sourcePersonalAccessTokenCheck = new SourcePersonalAccessTokenCheck();

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
