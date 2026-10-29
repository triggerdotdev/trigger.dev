import { z } from "zod/v4";

export const CreateAuthorizationCodeRequestSchema = z.object({
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal("S256"),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
});

export type CreateAuthorizationCodeRequest = z.infer<typeof CreateAuthorizationCodeRequestSchema>;

export const CreateAuthorizationCodeResponseSchema = z.object({
  url: z.string().url(),
  authorizationCode: z.string(),
  /**
   * How the approval code reaches the client. Absent when the server predates approval codes, in
   * which case the client polls for the token with the authorization code alone.
   */
  approval: z.enum(["callback", "paste"]).optional(),
});

export type CreateAuthorizationCodeResponse = z.infer<typeof CreateAuthorizationCodeResponseSchema>;

export const GetPersonalAccessTokenRequestSchema = z.object({
  authorizationCode: z.string(),
  codeVerifier: z.string().optional(),
  approvalCode: z.string().optional(),
});
export type GetPersonalAccessTokenRequest = z.infer<typeof GetPersonalAccessTokenRequestSchema>;

export const GetPersonalAccessTokenResponseSchema = z.object({
  token: z
    .object({
      token: z.string(),
      obfuscatedToken: z.string(),
    })
    .nullable(),
});
export type GetPersonalAccessTokenResponse = z.infer<typeof GetPersonalAccessTokenResponseSchema>;
