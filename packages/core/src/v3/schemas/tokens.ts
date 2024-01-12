import { z } from "zod";

export const CreateAuthorizationCodeResponseSchema = z.object({
  url: z.string().url(),
  authorizationCode: z.string(),
});

export type CreateAuthorizationCodeResponse = z.infer<typeof CreateAuthorizationCodeResponseSchema>;

export const GetPersonalAccessTokenRequestSchema = z.object({
  authorizationCode: z.string(),
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
