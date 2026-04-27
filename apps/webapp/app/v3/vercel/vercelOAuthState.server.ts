import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { z } from "zod";
import { env } from "~/env.server";

export const VercelOAuthStateSchema = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentSlug: z.string(),
  organizationSlug: z.string(),
  projectSlug: z.string(),
});

export type VercelOAuthState = z.infer<typeof VercelOAuthStateSchema>;

export async function generateVercelOAuthState(
  params: VercelOAuthState
): Promise<string> {
  return generateJWT({
    secretKey: env.ENCRYPTION_KEY,
    payload: params,
    expirationTime: "15m",
  });
}

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
