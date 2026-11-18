import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * The acting user on a public JWT. The JWT route stamps it when it mints a token from a PAT or
 * user-actor token exchange, with a signature only the server can make: anyone holding the
 * environment's root key can sign a JWT naming any user, but not this signature.
 */
export type PublicJwtActorClaim = { sub: string; client?: string; pat?: string; sig?: string };

/**
 * `verified` is true only when the server signed this user onto this exact token. `pat` is the
 * sealed source PAT, which the bearer resolver checks on every use.
 */
export type PublicJwtActor = { sub: string; client?: string; pat?: string; verified: boolean };

/**
 * The token's other claims that the server reads: what the token may do, and for how long. The
 * signature covers them with the actor, so a signature copied onto a token with different claims
 * (wider scopes, no `pat`, another expiry) doesn't verify.
 */
export type PublicJwtClaims = {
  /** The environment the token is for. */
  environmentId: string;
  /** The token's expiry, in seconds since the epoch. */
  expiresAt: number;
  scopes?: string[];
  oneTimeUse?: boolean;
  realtime?: { skipColumns?: string[] };
};

// A key of its own, derived from the public token secret like the sealed subject and source PAT
// keys (`createSealedIdCodec` in @trigger.dev/rbac): no other use of that secret can produce one
// of these signatures.
const KEY_INFO = "trigger.dev public token actor v1";
const keys = new Map<string, Buffer>();

function actorKey(secret: string): Buffer {
  if (!secret) {
    throw new Error("A secret is required to sign public JWT actors");
  }
  let key = keys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 32));
    keys.set(secret, key);
  }
  return key;
}

/**
 * The bytes the signature covers: every claim, in a fixed order, with sets sorted so their order in
 * the token can't change the result. Absent scopes count as none, as the readers treat them.
 */
function signedBytes(actor: Omit<PublicJwtActorClaim, "sig">, claims: PublicJwtClaims): string {
  return JSON.stringify([
    claims.environmentId,
    claims.expiresAt,
    actor.sub,
    actor.client ?? null,
    actor.pat ?? null,
    sortedSet(claims.scopes, []),
    claims.oneTimeUse === true,
    sortedSet(claims.realtime?.skipColumns, null),
  ]);
}

/**
 * The bearer resolver passes claims through as the token has them, so one may not be a list. It
 * then serializes as a value the server never signs, so the token doesn't verify.
 */
function sortedSet(values: unknown, absent: unknown[] | null): unknown {
  if (values === undefined) return absent;
  if (!Array.isArray(values)) return "malformed";
  return [...values].sort();
}

export function signPublicJwtActor(
  secret: string,
  actor: Omit<PublicJwtActorClaim, "sig">,
  claims: PublicJwtClaims
): string {
  return createHmac("sha256", actorKey(secret))
    .update(signedBytes(actor, claims))
    .digest("base64url");
}

/**
 * Reads a public JWT's `act` claim. The user is passed through as before; `verified` says whether
 * the server signed it together with exactly these claims.
 */
export function publicJwtActor(
  secret: string,
  claim: PublicJwtActorClaim | undefined,
  claims: Omit<PublicJwtClaims, "expiresAt"> & { expiresAt: number | undefined }
): PublicJwtActor | undefined {
  if (!claim) return undefined;

  const { sig, ...actor } = claim;
  const { expiresAt } = claims;
  if (!sig || expiresAt === undefined) return { ...actor, verified: false };

  const expected = Buffer.from(signPublicJwtActor(secret, actor, { ...claims, expiresAt }));
  const presented = Buffer.from(sig);
  const verified = presented.length === expected.length && timingSafeEqual(presented, expected);

  return { ...actor, verified };
}

/** The claims the RBAC bearer resolver passes through from a public JWT it verified. */
type BearerJwtClaims = {
  act?: PublicJwtActorClaim;
  expiresAt?: number;
  scopes?: string[];
  oneTimeUse?: boolean;
  realtime?: { skipColumns?: string[] };
};

/** The actor of a public JWT authenticated by the RBAC bearer resolver. */
export function bearerPublicJwtActor(
  secret: string,
  environmentId: string,
  jwt: BearerJwtClaims | undefined
): PublicJwtActor | undefined {
  return publicJwtActor(secret, jwt?.act, {
    environmentId,
    expiresAt: jwt?.expiresAt,
    scopes: jwt?.scopes,
    oneTimeUse: jwt?.oneTimeUse,
    realtime: jwt?.realtime,
  });
}
