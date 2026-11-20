import { getMeter } from "@internal/tracing";
import type {
  AuditLogActor,
  AuditLogContext,
  AuditLogCredential,
  AuditLogEndpoint,
  AuditLogSource,
} from "@trigger.dev/plugins";
import type { HostBearerAuthResult } from "@trigger.dev/rbac";
import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import { getHttpContext, type RequestAuditIdentity } from "~/services/httpAsyncStorage.server";
import { bearerPublicJwtActor, type PublicJwtActor } from "~/services/publicJwtActor.server";
import { publicTokenSecret } from "~/services/publicTokenSubject.server";
import { hashApiKey } from "~/utils/apiKeys";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { singleton } from "~/utils/singleton";
import { auditLogs } from "./auditLogs.server";

// The auth functions call these on success to say who is making the request. They run on every
// authenticated request, so they only read what auth already resolved. The one query is the
// credential's fingerprint lookup, which starts only when the request records an event, and the
// request never waits for it. The presented credential is hashed only then. They never throw, and
// they do nothing outside an HTTP request.

const MAX_USER_AGENT_LENGTH = 300;

/** How long an event waits for its credential's fingerprint before recording it without one. */
const FINGERPRINT_WAIT_MS = 200;

const TIMED_OUT = Symbol("timed out");

/** Why a request's event has no fingerprint, kept with its context until it is recorded. */
const missingFingerprint = new WeakMap<
  AuditLogContext,
  "request_lookup_timed_out" | "request_not_found"
>();

/**
 * Counts an event that is being recorded without its credential's fingerprint, on the same counter
 * the audit log plugin's writer adds to. The host calls it once the event has passed the recording
 * gates, so events an organization doesn't record aren't counted.
 */
export function countMissingFingerprint(context: AuditLogContext): void {
  const reason = missingFingerprint.get(context);
  if (!reason) return;
  // Created on first use, not at import: before the tracer registers its meter provider,
  // `getMeter` returns a meter that records nothing.
  singleton("auditEventsWithoutFingerprint", () =>
    getMeter("audit-logs").createCounter("audit_logs.events_without_fingerprint", {
      description: "Audit events that named a credential but got no fingerprint, by reason",
    })
  ).add(1, { reason });
}

/**
 * The audit context for an event recorded now, from what the request's auth functions noted. Read
 * synchronously; resolves later only to wait (briefly) for the credential's fingerprint.
 */
export function getRequestAuditContext(
  occurredAt: Date
): AuditLogContext | Promise<AuditLogContext> {
  const httpContext = getHttpContext();
  const identity = httpContext?.auditIdentity;

  const context: AuditLogContext = {
    occurredAt,
    actor: identity?.actor ?? null,
    credential: identity?.credential ?? null,
    onBehalfOf: identity?.onBehalfOf ?? null,
    source: identity?.source ?? null,
    endpoint: identity?.endpoint ?? null,
    origin: identity?.origin ?? null,
    requestId: httpContext?.requestId ?? null,
  };

  const credential = context.credential;
  const lookUpFingerprint = identity?.lookUpCredentialFingerprint;
  if (!credential || !lookUpFingerprint) return context;

  return settleWithin(lookUpFingerprint(), FINGERPRINT_WAIT_MS).then((found) => {
    const resolved: AuditLogContext = {
      ...context,
      credential: { ...credential, fingerprintId: typeof found === "string" ? found : null },
    };
    // Undefined without the plugin: nothing is fingerprinted, so nothing is missing.
    if (found === TIMED_OUT) missingFingerprint.set(resolved, "request_lookup_timed_out");
    else if (found === null) missingFingerprint.set(resolved, "request_not_found");
    return resolved;
  });
}

/**
 * Who the request's auth functions said is acting: a user, an API key, an organization access
 * token or a run. Null outside an authenticated request.
 */
export function getRequestActor(): AuditLogActor | null {
  return getHttpContext()?.auditIdentity?.actor ?? null;
}

/** A dashboard session. While staff impersonate a user, the user is the actor. */
export function noteSessionAuthentication(
  request: Request,
  session: { userId: string; impersonatorUserId?: string | null }
): void {
  setAuditIdentity(request, () => ({
    actor: { type: "user", id: session.userId },
    credential: null,
    onBehalfOf: session.impersonatorUserId ? { userId: session.impersonatorUserId } : null,
    source: session.impersonatorUserId ? "staff" : "dashboard",
    origin: null,
  }));
}

/** An environment bearer credential resolved by the RBAC host: root or additional key, public JWT or run token. */
export function noteBearerAuthentication(request: Request, result: HostBearerAuthResult): void {
  if (!result.ok) return;

  setAuditIdentity(request, () => {
    const { subject, environment, resolution } = result;

    if (subject.type === "runToken") {
      return {
        actor: { type: "run", id: subject.runId },
        // The run id is the actor; the token has no id of its own.
        credential: { kind: "run_token", id: null, last4: null, fingerprintId: null },
        onBehalfOf: null,
        source: "run",
        origin: null,
      };
    }

    if (subject.type === "publicJWT") {
      return publicJwtIdentity(request, {
        signingEnvironmentId:
          resolution.jwtSigningKey?.environmentId ?? rootKeyEnvironmentId(environment),
        signingKeyLast4: resolution.jwtSigningKey?.last4 ?? null,
        hashSigningKey: resolution.jwtSigningKey?.hash,
        actingUserId: verifiedActingUserId(
          bearerPublicJwtActor(publicTokenSecret(), environment.id, result.jwt)
        ),
      });
    }

    const token = bearerToken(request) ?? "";

    // An additional key has a row id: the audit plugin finds its fingerprint by kind and id.
    if (subject.type === "apiKey") {
      return apiKeyIdentity(request, {
        kind: "additional_api_key",
        id: subject.apiKeyId,
        last4: lastFour(token),
      });
    }

    // Root and legacy environment keys resolve to a user subject, so the key is identified by the
    // environment that owns it: a branch uses its parent's key. A grace-window rotated key has
    // its own fingerprint, found by its own hash.
    return apiKeyIdentity(
      request,
      { kind: "root_api_key", id: rootKeyEnvironmentId(environment), last4: lastFour(token) },
      () => hashApiKey(token)
    );
  });
}

/** The pre-RBAC API-key path: root or additional key, or a public JWT. */
export function noteLegacyApiKeyAuthentication(
  request: Request,
  result:
    | {
        ok: true;
        apiKey: string;
        type: "PUBLIC" | "PRIVATE" | "PUBLIC_JWT";
        environment: { id: string; parentEnvironmentId: string | null };
        actor?: VerifiedActor;
        jwtSigningKeyLast4?: string;
        jwtSigningKeyHash?: () => string;
      }
    | { ok: false }
    | undefined
): void {
  if (!result?.ok) return;

  setAuditIdentity(request, () => {
    const signingEnvironmentId = rootKeyEnvironmentId(result.environment);

    if (result.type === "PUBLIC_JWT") {
      return publicJwtIdentity(request, {
        signingEnvironmentId,
        signingKeyLast4: result.jwtSigningKeyLast4 ?? null,
        hashSigningKey: result.jwtSigningKeyHash,
        actingUserId: verifiedActingUserId(result.actor),
      });
    }

    // Deprecated `pk_` keys have no credential kind of their own.
    if (result.type === "PUBLIC") {
      return apiKeyIdentity(request, null);
    }

    const token = result.apiKey.trim();
    return apiKeyIdentity(
      request,
      isAdditionalApiKey(token)
        ? // The legacy lookup doesn't return the key's row id.
          { kind: "additional_api_key", id: null, last4: lastFour(token) }
        : { kind: "root_api_key", id: signingEnvironmentId, last4: lastFour(token) },
      () => hashApiKey(token)
    );
  });
}

/**
 * A personal access token, or a user-actor token. Both act as their user. A user-actor token
 * minted from a personal access token names it in `pat`, and is recorded as that token. One
 * minted without a PAT, such as from a dashboard session, has no credential to record.
 */
export function notePersonalAccessTokenAuthentication(
  request: Request,
  auth: { userId: string; tokenId?: string; userActor?: { pat?: string } }
): void {
  setAuditIdentity(request, () => {
    const actor: AuditLogActor = { type: "user", id: auth.userId };
    const source = sourceFromHeaders(request);

    if (auth.userActor) {
      const sourcePatId = auth.userActor.pat;
      return {
        actor,
        credential: sourcePatId
          ? // Its last 4 would not identify the PAT behind it.
            { kind: "pat", id: sourcePatId, last4: null, fingerprintId: null }
          : null,
        onBehalfOf: null,
        source,
        origin: null,
        // A user-actor token is not the personal access token, so it has no fingerprint of its own.
      };
    }

    const token = bearerToken(request) ?? "";
    return {
      actor,
      credential: {
        kind: "pat",
        id: auth.tokenId ?? null,
        last4: lastFour(token),
        fingerprintId: null,
      },
      onBehalfOf: null,
      source,
      origin: null,
    };
  });
}

/** An organization access token. It has no user, so the token is the actor. */
export function noteOrganizationAccessTokenAuthentication(
  request: Request,
  auth: { tokenId: string }
): void {
  setAuditIdentity(request, () => {
    const token = bearerToken(request) ?? "";
    return {
      actor: { type: "oat", id: auth.tokenId },
      credential: { kind: "oat", id: auth.tokenId, last4: lastFour(token), fingerprintId: null },
      onBehalfOf: null,
      source: sourceFromHeaders(request),
      origin: null,
    };
  });
}

/**
 * What a note function learned. `hashCredential` returns the SHA-256 hex of the credential that has
 * a fingerprint; it runs only when a lookup starts, and neither it nor its result is stored.
 * Only credentials without a row id need it: root keys, the root key signing a public JWT, and
 * legacy-path additional keys. A PAT, OAT or RBAC additional key is identified by its row id: the
 * host records its kind and id with no fingerprint, and the audit plugin finds the fingerprint.
 */
type NotedIdentity = Omit<RequestAuditIdentity, "endpoint" | "lookUpCredentialFingerprint"> & {
  hashCredential?: () => string;
};

function setAuditIdentity(request: Request, build: () => NotedIdentity): void {
  try {
    const httpContext = getHttpContext();
    if (!httpContext) return;

    const { hashCredential, ...identity } = build();
    httpContext.auditIdentity = {
      ...identity,
      endpoint: endpointFromRequest(request),
      lookUpCredentialFingerprint: hashCredential ? lookUpOnce(hashCredential) : undefined,
    };
  } catch {
    // Auditing must never fail authentication.
  }
}

/**
 * The credential's fingerprint lookup, started by the first event that asks for it and shared by
 * the rest. Requests that record nothing never query. Resolves to null when none is found or the
 * lookup fails (the host logs the failure), and to undefined when the plugin is missing.
 */
function lookUpOnce(hashCredential: () => string): () => Promise<string | null | undefined> {
  let lookup: Promise<string | null | undefined> | undefined;
  return () =>
    (lookup ??= auditLogs
      .isFingerprintingEnabled()
      .then((enabled) =>
        enabled
          ? auditLogs
              .findCredentialFingerprint(hashCredential())
              .then((found) => found?.fingerprintId ?? null)
          : undefined
      )
      .catch(() => null));
}

/** The promise's value, null if it rejects, or TIMED_OUT after `ms`. Never rejects. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

function apiKeyIdentity(
  request: Request,
  credential: Omit<AuditLogCredential, "fingerprintId"> | null,
  hashCredential?: () => string
): NotedIdentity {
  const actor: AuditLogActor = { type: "api_key", id: credential?.id ?? null };
  return {
    actor,
    credential: credential ? { ...credential, fingerprintId: null } : null,
    onBehalfOf: null,
    source: sourceFromHeaders(request),
    origin: null,
    hashCredential,
  };
}

/** The parts of a public JWT's actor that audit reads. */
type VerifiedActor = Pick<PublicJwtActor, "sub" | "verified">;

/**
 * The acting user of a public JWT, only when the server signed it onto the token. Anyone holding
 * the root key can sign a JWT naming any user; such a token is attributed to the key.
 */
function verifiedActingUserId(actor: VerifiedActor | undefined) {
  return actor?.verified ? actor.sub : undefined;
}

/**
 * Public JWTs are attributed to the root key that signed them. The acting user comes from the
 * `act` claim only when the server's signature on it checks out.
 */
function publicJwtIdentity(
  request: Request,
  jwt: {
    signingEnvironmentId: string;
    signingKeyLast4: string | null;
    hashSigningKey?: () => string;
    actingUserId?: string;
  }
): NotedIdentity {
  return {
    actor: jwt.actingUserId
      ? { type: "user", id: jwt.actingUserId }
      : { type: "api_key", id: jwt.signingEnvironmentId },
    credential: {
      kind: "public_jwt",
      id: jwt.signingEnvironmentId,
      last4: jwt.signingKeyLast4,
      fingerprintId: null,
    },
    onBehalfOf: null,
    source: sourceFromHeaders(request),
    origin: null,
    // The token itself has no fingerprint: the key that signed it does.
    hashCredential: jwt.hashSigningKey,
  };
}

function rootKeyEnvironmentId(environment: {
  id: string;
  parentEnvironmentId: string | null;
}): string {
  return environment.parentEnvironmentId ?? environment.id;
}

/**
 * Which client made an API call: the CLI or the plain API. The header is set by our CLI but not
 * verified, so this is a display hint, never an authorization input. `run` comes only from
 * run-token authentication, which a header can't fake.
 */
function sourceFromHeaders(request: Request): AuditLogSource {
  const client = request.headers.get("x-trigger-source");
  return client === "cli" || client === "mcp" ? "cli" : "api";
}

function endpointFromRequest(request: Request): AuditLogEndpoint {
  return {
    ip: extractClientIp(request.headers.get("x-forwarded-for")),
    userAgent: request.headers.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
  };
}

function bearerToken(request: Request): string | undefined {
  return request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
}

function lastFour(token: string | undefined): string | null {
  return token && token.length >= 8 ? token.slice(-4) : null;
}
