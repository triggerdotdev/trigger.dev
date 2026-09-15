import { buildJwtAbility, verifyUserActorToken } from "@trigger.dev/rbac";
import { vi } from "vitest";

/**
 * Shared `vi.mock` factory bodies for the PAT-route suites that drive a real signed token
 * against a real database (`~/db.server` pointed at the container's client). Each export returns
 * the module shape to hand to `vi.mock`; `vi.mock` itself must stay a one-line call at the top
 * level of each suite for vitest's hoisting to pick it up.
 */

/** A `~/db.server` mock: every property proxies through to `ctx.prisma`, set once the container
 * hands back its client — so the mock can be installed before that client exists. */
export function dbServerProxyMock(ctx: { prisma: unknown }, sqlDatabaseSchema?: unknown) {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema };
}

export function loggerMock() {
  return { logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } };
}

export function authTelemetryMock() {
  return { authenticateBearerWithTelemetry: vi.fn() };
}

export function tenantContextMock(opts: { withRun?: boolean } = {}) {
  return {
    tenantContext: {
      enrich: vi.fn(),
      ...(opts.withRun ? { run: (_ctx: unknown, fn: () => unknown) => fn() } : {}),
    },
    tenantContextFromAuthEnvironment: vi.fn(),
  };
}

export function workerGroupTokenServiceMock() {
  return { WorkerGroupTokenService: class {} };
}

export function serviceValidationErrorMock() {
  return { ServiceValidationError: class extends Error {} };
}

export function engineServiceValidationErrorMock() {
  return { EngineServiceValidationError: class extends Error {} };
}

/** `~/services/personalAccessToken.server`: the plugin already verified the claims, so the
 * liveness recheck is a no-op by default; pass a real recheck when a suite exercises it. */
export function personalAccessTokenMock(
  opts: {
    assertSourcePatActive?: true;
    resolveAndRecheckUserActorClaims?: (claims: unknown, bearer: string) => Promise<unknown>;
  } = {}
) {
  return {
    updateLastAccessedAtIfStale: vi.fn(),
    resolveAndRecheckUserActorClaims:
      opts.resolveAndRecheckUserActorClaims ?? (async (claims: unknown) => claims),
    ...(opts.assertSourcePatActive ? { assertSourcePatActive: async () => true } : {}),
  };
}

export function bearerOf(request: Request) {
  return (
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim() ?? ""
  );
}

/** The OSS RBAC fallback's `authenticateUserActor`: verify the token, ability from its own cap. */
export function ossAuthenticateUserActor(sessionSecret: string) {
  return async (request: Request, context: { organizationId?: string } = {}) => {
    const claims = await verifyUserActorToken(sessionSecret, bearerOf(request));
    if (!claims) return { ok: false, status: 401, error: "Invalid user-actor token" };
    return {
      ok: true,
      userId: claims.userId,
      claims,
      subject: {
        type: "userActor",
        userId: claims.userId,
        organizationId: context.organizationId ?? "",
      },
      ability: buildJwtAbility(claims.cap ?? ["read:all"]),
    };
  };
}
