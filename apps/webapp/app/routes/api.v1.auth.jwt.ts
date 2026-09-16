import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { resolveJwtSigningKey, scopesWithinAbility } from "@trigger.dev/rbac";
import parseDuration from "parse-duration";
import { z } from "zod";
import { authenticateBearerWithTelemetry } from "~/services/authTelemetry.server";
import { isApiKeyInGraceWindow, presentedBearerToken } from "~/services/apiKeyGraceWindow.server";
import { logger } from "~/services/logger.server";

const RequestBodySchema = z.object({
  claims: z
    .object({
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  expirationTime: z.union([z.number(), z.string()]).optional(),
});

const DEFAULT_EXPIRY = "1h";
// A minted public JWT may be valid for at most 24 hours. A caller-controlled,
// uncapped `expirationTime` ("100y") would otherwise mint a token that no key
// rotation can revoke — public JWTs are not invalidated by rotating the
// environment's key. The cap is the compensating control for that.
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;

// A requested `expirationTime` above this (epoch seconds, ~2001) is an absolute
// timestamp; a smaller number is a relative offset in seconds.
const EXPIRY_EPOCH_THRESHOLD_SECONDS = 1_000_000_000;

// Resolve the requested expiry to an absolute epoch-second timestamp so it can
// be capped. Returns undefined when a string can't be parsed as a duration.
function resolveRequestedExpirySeconds(
  expirationTime: number | string | undefined,
  nowSec: number
): number | undefined {
  if (typeof expirationTime === "number") {
    return expirationTime > EXPIRY_EPOCH_THRESHOLD_SECONDS
      ? expirationTime
      : nowSec + expirationTime;
  }
  const durationMs = parseDuration(expirationTime ?? DEFAULT_EXPIRY);
  if (durationMs == null) {
    return undefined;
  }
  return nowSec + Math.floor(durationMs / 1000);
}

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
    const requestedAbsSec = resolveRequestedExpirySeconds(parsedBody.data.expirationTime, nowSec);
    if (requestedAbsSec === undefined) {
      return json({ error: "Invalid expiration time" }, { status: 400 });
    }
    if (requestedAbsSec <= nowSec) {
      return json({ error: "Expiration time must be in the future" }, { status: 400 });
    }
    if (requestedAbsSec - nowSec > MAX_EXPIRY_SECONDS) {
      return json({ error: "Expiration time cannot exceed 24 hours" }, { status: 400 });
    }

    const claims = {
      sub: authenticationResult.environment.id,
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
      expirationTime: requestedAbsSec,
    });

    return json({ token: jwt });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to mint auth jwt", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
