import { trace } from "@internal/tracing";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { decodeJwt } from "jose";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getExternalOidcController, getExternalOidcRateLimits } from "./externalOidc.server";
import { ExternalOidcTokenRequest } from "./externalOidcTokenRequest";
import { internalRunSigningService } from "./instance.server";
import { externalOidcTelemetry } from "./externalOidcTelemetry.server";
import { isRunTokenFormat, verifyRunToken, type RunTokenClaims } from "./runTokenVerify";

const NO_STORE = { "Cache-Control": "no-store" };

export async function externalOidcTokenAction({ request }: ActionFunctionArgs) {
  const startedAt = performance.now();
  const span = trace.getActiveSpan();
  let outcome = "OIDC_SERVICE_UNAVAILABLE";
  let claims: RunTokenClaims | undefined;

  function failure(
    code: string,
    error: string,
    status: number,
    headers: Record<string, string> = {}
  ) {
    outcome = code;
    return json({ error, code }, { status, headers: { ...NO_STORE, ...headers } });
  }

  try {
    if (request.method !== "POST") {
      return failure("METHOD_NOT_ALLOWED", "Method not allowed", 405, { Allow: "POST" });
    }

    const controller = await getExternalOidcController();
    if (!controller) {
      return failure(
        "OIDC_UNAVAILABLE",
        "External OIDC is only available on Trigger.dev Cloud",
        503,
        { "x-should-retry": "false" }
      );
    }

    // Only run tokens: root keys, PATs, sessions and public JWTs cannot mint.
    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
    claims =
      bearer && env.RUN_TOKEN_ISSUER_URL && isRunTokenFormat(bearer)
        ? await verifyRunToken({
            token: bearer,
            jwks: await internalRunSigningService.getPublicJwks(),
            issuer: env.RUN_TOKEN_ISSUER_URL,
          })
        : undefined;
    if (!claims) {
      return failure("INVALID_RUN_TOKEN", "A valid run bearer token is required", 401);
    }

    const parsed = ExternalOidcTokenRequest.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return failure(
        "INVALID_REQUEST",
        parsed.error.issues[0]?.message ?? "Invalid OIDC token request",
        400
      );
    }

    const retryAfter = await getExternalOidcRateLimits().check(
      claims.environment_id,
      claims.run_id
    );
    if (retryAfter !== undefined) {
      return failure("RATE_LIMIT_EXCEEDED", "OIDC token rate limit exceeded", 429, {
        "Retry-After": String(retryAfter),
        "x-ratelimit-reset": String(Date.now() + retryAfter * 1_000),
      });
    }

    const result = await controller.mint({
      run: {
        organizationId: claims.org_id,
        projectId: claims.project_id,
        environmentId: claims.environment_id,
        runId: claims.run_id,
        attempt: claims.attempt,
      },
      audience: parsed.data.audience,
      awsSessionTags: parsed.data.awsSessionTags,
    });
    if (!result.ok) return failure(result.code, result.message, result.status);

    const expiry = decodeJwt(result.token).exp;
    if (typeof expiry !== "number") throw new Error("OIDC plugin returned a token without expiry");
    outcome = "minted";
    return json(
      { token: result.token, expiresAt: new Date(expiry * 1_000).toISOString() },
      { headers: NO_STORE }
    );
  } catch (error) {
    logger.error("External OIDC mint failed", {
      error,
      organizationId: claims?.org_id,
      projectId: claims?.project_id,
      environmentId: claims?.environment_id,
      runId: claims?.run_id,
    });
    return failure(
      "OIDC_SERVICE_UNAVAILABLE",
      "OIDC token service is temporarily unavailable",
      503
    );
  } finally {
    const telemetry = externalOidcTelemetry();
    telemetry.tokenRequests.add(1, { outcome });
    telemetry.tokenDuration.record(performance.now() - startedAt, { outcome });
    // Reuse the request's sampling decision; tenant IDs never become metric labels.
    if (span?.isRecording()) {
      span.setAttributes({
        "oidc.outcome": outcome,
        ...(claims && {
          "oidc.organization_id": claims.org_id,
          "oidc.project_id": claims.project_id,
          "oidc.environment_id": claims.environment_id,
          "oidc.run_id": claims.run_id,
          "oidc.attempt": claims.attempt,
        }),
      });
    }
  }
}
