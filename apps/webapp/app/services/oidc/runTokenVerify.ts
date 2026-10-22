import { decodeProtectedHeader } from "jose";
import { z } from "zod";
import { verifyRs256Jwt, type PublicJwks } from "./crypto";
import { RUN_TOKEN_AUDIENCE, RUN_TOKEN_TYPE, RUN_TOKEN_USE } from "./runTokenClaims";

const RunTokenPayload = z.object({
  // jose accepts an audience array that merely contains ours; run tokens must name only us.
  aud: z.literal(RUN_TOKEN_AUDIENCE),
  token_use: z.literal(RUN_TOKEN_USE),
  org_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  run_id: z.string(),
  attempt: z.number().int(),
  scopes: z.array(z.string()),
});

export type RunTokenClaims = Omit<z.infer<typeof RunTokenPayload>, "aud">;

/** Routing hint from the unverified header. Never use it for authorization. */
export function isRunTokenFormat(token: string): boolean {
  try {
    return decodeProtectedHeader(token).typ === RUN_TOKEN_TYPE;
  } catch {
    return false;
  }
}

/**
 * Returns the claims of a valid run token, or undefined for anything else. `jwks` must be the
 * internal run key set: external OIDC keys must never be trusted here.
 */
export async function verifyRunToken({
  token,
  jwks,
  issuer,
  now,
}: {
  token: string;
  jwks: PublicJwks;
  issuer: string;
  now?: Date;
}): Promise<RunTokenClaims | undefined> {
  try {
    const { payload } = await verifyRs256Jwt({
      token,
      jwks,
      issuer,
      audience: RUN_TOKEN_AUDIENCE,
      typ: RUN_TOKEN_TYPE,
      now,
    });
    const parsed = RunTokenPayload.safeParse(payload);
    if (!parsed.success) return undefined;

    const { aud: _aud, ...claims } = parsed.data;
    return claims;
  } catch {
    return undefined;
  }
}
