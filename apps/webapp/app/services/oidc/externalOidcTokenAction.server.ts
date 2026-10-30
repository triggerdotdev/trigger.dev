import { json, type ActionFunctionArgs } from "@remix-run/node";
import { decodeJwt } from "jose";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  externalOidcOutcomes,
  getExternalOidcController,
  getExternalOidcRateLimits,
} from "./externalOidc.server";
import { internalRunSigningService } from "./instance.server";
import { isRunTokenFormat, verifyRunToken } from "./runTokenVerify";

const MAX_AUDIENCE_LENGTH = 2_048;

const TokenRequest = z
  .object({
    // An audience is an opaque signed value. It is never fetched or used as a URL.
    audience: z
      .string()
      .min(1)
      .max(MAX_AUDIENCE_LENGTH)
      .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
  })
  .strict();

const NO_STORE = { "Cache-Control": "no-store" };

function failure(
  code: string,
  error: string,
  status: number,
  headers: Record<string, string> = {}
) {
  externalOidcOutcomes.add(1, { outcome: code });
  return json({ error, code }, { status, headers: { ...NO_STORE, ...headers } });
}

export async function externalOidcTokenAction({ request }: ActionFunctionArgs) {
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

  try {
    // Only run tokens: root keys, PATs, sessions and public JWTs cannot mint.
    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
    const claims =
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

    const parsed = TokenRequest.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return failure(
        "INVALID_REQUEST",
        `A non-empty audience of at most ${MAX_AUDIENCE_LENGTH} characters without control characters or surrounding whitespace is required`,
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
    });
    if (!result.ok) return failure(result.code, result.message, result.status);

    const expiry = decodeJwt(result.token).exp;
    if (typeof expiry !== "number") throw new Error("OIDC plugin returned a token without expiry");
    externalOidcOutcomes.add(1, { outcome: "minted" });
    return json(
      { token: result.token, expiresAt: new Date(expiry * 1_000).toISOString() },
      { headers: NO_STORE }
    );
  } catch (error) {
    logger.error("External OIDC mint failed", { error });
    return failure(
      "OIDC_SERVICE_UNAVAILABLE",
      "OIDC token service is temporarily unavailable",
      503
    );
  }
}
