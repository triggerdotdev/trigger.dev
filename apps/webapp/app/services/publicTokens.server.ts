import { generateJWT } from "@trigger.dev/core/v3/jwt";
import type { RoleBaseAccessController } from "@trigger.dev/rbac";
import { resolveJwtSigningKey, scopesWithinAbility } from "@trigger.dev/rbac";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { apiKeyTelemetry, type ApiKeyTelemetry } from "~/services/apiKeyTelemetry.server";
import { rbac } from "~/services/rbac.server";

// Public access tokens may be valid for at most 30 days.
const MAX_PUBLIC_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

const RequestBodySchema = z.object({
  scopes: z.array(z.string()).min(1),
  expirationTime: z.union([z.string(), z.number()]).optional(),
  oneTimeUse: z.boolean().optional(),
  realtime: z
    .object({
      skipColumns: z.array(z.string()).optional(),
    })
    .optional(),
});

const RELATIVE_TIME_PATTERN =
  /^(\+|-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;

function expirationTimestamp(expirationTime: string | number, now: number): number | undefined {
  if (typeof expirationTime === "number") {
    return expirationTime;
  }

  const match = RELATIVE_TIME_PATTERN.exec(expirationTime);
  if (!match || (match[4] && match[1])) {
    return undefined;
  }

  const value = Number.parseFloat(match[2]!);
  const unit = match[3]!.toLowerCase();
  const unitSeconds = unit.startsWith("s")
    ? 1
    : unit.startsWith("m")
      ? 60
      : unit.startsWith("h")
        ? 60 * 60
        : unit.startsWith("d")
          ? 24 * 60 * 60
          : unit.startsWith("w")
            ? 7 * 24 * 60 * 60
            : 365.25 * 24 * 60 * 60;
  const relativeSeconds = Math.round(value * unitSeconds);
  const isPast = match[1] === "-" || match[4]?.toLowerCase() === "ago";

  return now + (isPast ? -relativeSeconds : relativeSeconds);
}

export async function handlePublicTokenRequest(
  request: Request,
  controller: Pick<RoleBaseAccessController, "authenticateBearer"> = rbac,
  telemetryRecorder: ApiKeyTelemetry = apiKeyTelemetry
) {
  // Public JWTs are intentionally not enabled here. Only API keys may mint tokens.
  const authResult = await controller.authenticateBearer(request);
  if (!authResult.ok) {
    return json({ error: authResult.error }, { status: authResult.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    telemetryRecorder.recordPublicTokenMint("rejected", "invalid_body");
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsedBody = RequestBodySchema.safeParse(body);
  if (!parsedBody.success) {
    telemetryRecorder.recordPublicTokenMint("rejected", "invalid_body");
    return json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const scopeCheck = scopesWithinAbility(parsedBody.data.scopes, authResult.ability);
  if (!scopeCheck.ok) {
    telemetryRecorder.recordPublicTokenMint("rejected", "scope_not_allowed");
    return json(
      {
        error: "Requested scopes exceed the API key's access",
        code: "scopes_exceed_key_access",
        deniedScopes: scopeCheck.deniedScopes,
      },
      { status: 403 }
    );
  }

  const expirationTime = parsedBody.data.expirationTime ?? "15m";
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expirationTimestamp(expirationTime, now);
  if (expiresAt === undefined) {
    telemetryRecorder.recordPublicTokenMint("rejected", "invalid_expiration");
    return json({ error: "Invalid expiration time" }, { status: 400 });
  }
  // `expirationTimestamp` accepts past values ("-5m", "5m ago"), which would
  // otherwise mint an already-expired token behind a 200.
  if (expiresAt <= now) {
    telemetryRecorder.recordPublicTokenMint("rejected", "expiration_not_future");
    return json({ error: "Expiration time must be in the future" }, { status: 400 });
  }
  if (expiresAt - now > MAX_PUBLIC_TOKEN_LIFETIME_SECONDS) {
    telemetryRecorder.recordPublicTokenMint("rejected", "expiration_too_long");
    return json({ error: "Expiration time cannot exceed 30 days" }, { status: 400 });
  }

  let token: string;
  try {
    token = await generateJWT({
      secretKey: resolveJwtSigningKey(authResult.environment),
      payload: {
        sub: authResult.environment.id,
        pub: true,
        scopes: parsedBody.data.scopes,
        ...(parsedBody.data.oneTimeUse ? { otu: true } : {}),
        ...(parsedBody.data.realtime ? { realtime: parsedBody.data.realtime } : {}),
      },
      // Pass the absolute `exp` validated above, not the original string.
      // `generateJWT` hands the string to jose's own parser, which would leave
      // the 30-day cap enforced against a different computation than the one
      // that actually sets the claim.
      expirationTime: expiresAt,
    });
  } catch (error) {
    telemetryRecorder.recordPublicTokenMint("error", "signing_failed");
    throw error;
  }

  telemetryRecorder.recordPublicTokenMint("success");
  return json({ token });
}
