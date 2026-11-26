import { timingSafeEqual } from "node:crypto";
import {
  createLocalJWKSet,
  decodeJwt,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/**
 * Verifies projected Kubernetes ServiceAccount tokens from trusted clusters (workload identity),
 * so in-cluster services can call the platform without a shared secret.
 */

/** Callers must request a projected token of at most this lifetime (the Kubernetes minimum). */
const WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS = 600;
const CLOCK_TOLERANCE_SECONDS = 30;
/** Covers the whole response, body included, so a stalled issuer cannot hold verifications. */
const FETCH_TIMEOUT_MS = 5_000;
// Also how long a key the issuer withdraws keeps verifying here.
const KEYS_MAX_AGE_MS = 10 * 60_000;
/** An unknown key id refetches at most this often, so forged key ids cannot hammer the issuer. */
const KEYS_REFETCH_COOLDOWN_MS = 30_000;

export type WorkloadIdentityPolicy = {
  /** Trusted cluster issuers, exactly as they appear in `iss`. */
  issuers: readonly string[];
  audience: string;
  /** The ServiceAccount, as `system:serviceaccount:<namespace>:<name>`. */
  subject: string;
};

/** Thrown when an issuer's keys cannot be fetched, so the caller can answer 503 rather than 401. */
export class WorkloadIdentityUnavailableError extends Error {}

const Claims = z.object({
  sub: z.string(),
  iat: z.number(),
  exp: z.number(),
  // Only projected tokens are bound to a pod; legacy Secret tokens never expire.
  "kubernetes.io": z.object({ pod: z.object({ name: z.string(), uid: z.string() }) }),
});

/**
 * True for a valid token of `policy.subject` from a trusted issuer. Throws
 * WorkloadIdentityUnavailableError when the issuer's keys cannot be fetched.
 */
export async function verifyWorkloadToken(
  token: string,
  policy: WorkloadIdentityPolicy
): Promise<boolean> {
  let issuer: string | undefined;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    return false;
  }
  // Untrusted until verified: only selects which allowlisted issuer's keys to try.
  if (!issuer || !policy.issuers.includes(issuer)) return false;

  const keys = issuerKeys(issuer);
  let payload: unknown;
  try {
    payload = (await verify(token, await keys.get(), issuer, policy)).payload;
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey)) return rejected(error);
    // The issuer may have rotated its signing key.
    const refreshed = await keys.refreshed();
    if (!refreshed) return false;
    try {
      payload = (await verify(token, refreshed, issuer, policy)).payload;
    } catch (retryError) {
      return rejected(retryError);
    }
  }
  const claims = Claims.safeParse(payload);
  return (
    claims.success &&
    // jose skips its own subject check when the expected subject is empty.
    claims.data.sub === policy.subject &&
    claims.data.exp - claims.data.iat <= WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS
  );
}

function verify(
  token: string,
  keys: JWTVerifyGetKey,
  issuer: string,
  policy: WorkloadIdentityPolicy
) {
  return jwtVerify(token, keys, {
    algorithms: ["RS256"],
    issuer,
    audience: policy.audience,
    subject: policy.subject,
    requiredClaims: ["iss", "aud", "sub", "iat", "exp"],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
}

/** Keys are local by now, so any JOSE failure is the token's fault. */
function rejected(error: unknown): false {
  if (error instanceof errors.JOSEError) return false;
  throw error;
}

/** A service's caller: a workload identity when trusted issuers are configured, else a shared token. */
export type ServiceCaller =
  | { kind: "workload"; policy: WorkloadIdentityPolicy }
  | { kind: "sharedToken"; token: string };

/** True when `bearer` authenticates `caller`. Throws WorkloadIdentityUnavailableError. */
export async function serviceCallerAuthenticated(
  bearer: string | undefined,
  caller: ServiceCaller
): Promise<boolean> {
  if (!bearer) return false;
  if (caller.kind === "workload") return verifyWorkloadToken(bearer, caller.policy);
  const actual = Buffer.from(bearer);
  const wanted = Buffer.from(caller.token);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

const Discovery = z.object({ issuer: z.string(), jwks_uri: z.string().url() });

/** One issuer's JWKS, found by OIDC discovery, cached per process and fetched one at a time. */
class IssuerKeys {
  #keys?: { get: JWTVerifyGetKey; fetchedAt: number };
  #fetching?: Promise<JWTVerifyGetKey>;

  constructor(private readonly issuer: string) {}

  get(): Promise<JWTVerifyGetKey> {
    if (this.#keys && Date.now() - this.#keys.fetchedAt < KEYS_MAX_AGE_MS) {
      return Promise.resolve(this.#keys.get);
    }
    return this.#fetch();
  }

  /** Fresh keys, or undefined when the cached ones are too recent to refetch. */
  async refreshed(): Promise<JWTVerifyGetKey | undefined> {
    if (this.#keys && Date.now() - this.#keys.fetchedAt < KEYS_REFETCH_COOLDOWN_MS) return;
    return this.#fetch();
  }

  #fetch() {
    this.#fetching ??= this.#load().finally(() => (this.#fetching = undefined));
    return this.#fetching;
  }

  async #load(): Promise<JWTVerifyGetKey> {
    try {
      const discovery = Discovery.parse(
        await fetchJson(`${this.issuer}/.well-known/openid-configuration`)
      );
      if (discovery.issuer !== this.issuer) throw new Error("discovery names another issuer");
      // The issuer is allowlisted, so the key location it advertises is trusted too, but never over
      // weaker transport than the issuer's own.
      const jwksUri = new URL(discovery.jwks_uri);
      if (jwksUri.protocol !== new URL(this.issuer).protocol) {
        throw new Error("JWKS must use the issuer's scheme");
      }
      const get = createLocalJWKSet((await fetchJson(jwksUri.href)) as JSONWebKeySet);
      this.#keys = { get, fetchedAt: Date.now() };
      return get;
    } catch (error) {
      throw new WorkloadIdentityUnavailableError(
        `Workload identity keys unavailable for ${this.issuer}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

const issuers = new Map<string, IssuerKeys>();

function issuerKeys(issuer: string) {
  let keys = issuers.get(issuer);
  if (!keys) {
    keys = new IssuerKeys(issuer);
    issuers.set(issuer, keys);
  }
  return keys;
}
