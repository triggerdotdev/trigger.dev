import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { resolveJwtSigningKey, scopesWithinAbility } from "@trigger.dev/rbac";
import { z } from "zod";
import { authenticateBearerWithTelemetry } from "~/services/authTelemetry.server";
import { isApiKeyInGraceWindow, presentedBearerToken } from "~/services/apiKeyGraceWindow.server";
import { validateJwtExpiration } from "~/services/jwtExpiration.server";
import { logger } from "~/services/logger.server";
import { publicTokenSubject } from "~/services/publicTokenSubject.server";

const RequestBodySchema = z.object({
  claims: z
    .object({
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  expirationTime: z.union([z.number(), z.string()]).optional(),
});

export async function action({ request }: LoaderFunctionArgs) {
  try {
    // Authenticate through the RBAC bearer controller (not the legacy
    // `authenticateApiRequest`): it exposes both the key's own ability (used
    // to clamp requested scopes below) and how the key resolved (used to
    // refuse grace-window keys). JWTs are not allowed to mint more JWTs.
    const authenticationResult = await authenticateBearerWithTelemetry(request, {
      allowJWT: false,
    });

    if (!authenticationResult.ok) {
      return json({ error: "Invalid or Missing API key" }, { status: authenticationResult.status });
    }
    if (authenticationResult.subject.type === "runToken") {
      return json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    // A revoked key still authenticates through the grace window (by design,
    // for zero-downtime rotation). It must not mint new JWTs: those are signed
    // with the *replacement* key (see below), so a token minted in the grace
    // window keeps validating after rotation — revoking the key would not cut
    // the caller off. Refuse the mint so rotation actually revokes.
    //
    // Detected by a direct RevokedApiKey lookup on the presenting bearer rather
    // than the auth layer's `resolution.lookupPath`: the RBAC plugin path (cloud)
    // resolves a grace-window key but does not surface a "root_rotated" marker,
    // so keying off resolution would silently no-op there. This check is
    // uniform across the plugin and OSS-fallback auth paths.
    const presentedApiKey = presentedBearerToken(request);

    if (presentedApiKey && (await isApiKeyInGraceWindow(presentedApiKey))) {
      return json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    const parsedBody = RequestBodySchema.safeParse(await request.json());

    if (!parsedBody.success) {
      return json(
        { error: "Invalid request body", issues: parsedBody.error.issues },
        { status: 400 }
      );
    }

    // A minted token must not be more powerful than the key that minted it.
    // The downstream JWT auth builds its ability purely from the token's
    // inline `scopes`, so caller-supplied scopes are validated against the
    // key's own ability — a restricted key can't widen its grant by minting.
    const requestedScopes = parsedBody.data.claims?.scopes ?? [];
    const scopeCheck = scopesWithinAbility(requestedScopes, authenticationResult.ability);
    if (!scopeCheck.ok) {
      return json(
        {
          error: "Requested scopes exceed the API key's access",
          code: "scopes_exceed_key_access",
          deniedScopes: scopeCheck.deniedScopes,
        },
        { status: 403 }
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = validateJwtExpiration(parsedBody.data.expirationTime, nowSec);
    if (expiry.error !== undefined) {
      return json({ error: expiry.error }, { status: 400 });
    }

    const claims = {
      sub: publicTokenSubject(authenticationResult.environment.id),
      pub: true,
      ...(requestedScopes.length > 0 ? { scopes: requestedScopes } : {}),
    };

    // Sign with the environment's current canonical signing key (the parent
    // env's key for branches), so JWTs validate through jwtAuth.server.ts.
    // Pass the absolute, capped `exp` — not the original caller string — so
    // the cap above is enforced against the same value that sets the claim.
    const jwt = await internal_generateJWT({
      secretKey: resolveJwtSigningKey(authenticationResult.environment),
      payload: claims,
      expirationTime: expiry.expirationTime,
    });

    return json({ token: jwt });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to mint auth jwt", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
