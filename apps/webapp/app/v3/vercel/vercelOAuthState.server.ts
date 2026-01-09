import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { z } from "zod";
import { env } from "~/env.server";

/**
 * Schema for Vercel OAuth state JWT payload.
 */
export const VercelOAuthStateSchema = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentSlug: z.string(),
  organizationSlug: z.string(),
  projectSlug: z.string(),
});

export type VercelOAuthState = z.infer<typeof VercelOAuthStateSchema>;

/**
 * Generate a JWT state token for Vercel OAuth flow.
 * This function is server-only as it requires the encryption key.
 *
 * @param params - The state parameters to encode
 * @returns A signed JWT token containing the state
 */
export async function generateVercelOAuthState(
  params: VercelOAuthState
): Promise<string> {
  return generateJWT({
    secretKey: env.ENCRYPTION_KEY,
    payload: params,
    // OAuth state tokens should be short-lived (15 minutes)
    expirationTime: "15m",
  });
}

/**
 * Validate and decode a Vercel OAuth state JWT token.
 *
 * @param token - The JWT token to validate
 * @returns The decoded state or null if invalid
 */
export async function validateVercelOAuthState(
  token: string
): Promise<{ ok: true; state: VercelOAuthState } | { ok: false; error: string }> {
  const result = await validateJWT(token, env.ENCRYPTION_KEY);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const parseResult = VercelOAuthStateSchema.safeParse(result.payload);
  if (!parseResult.success) {
    return { ok: false, error: "Invalid state payload" };
  }

  return { ok: true, state: parseResult.data };
}

