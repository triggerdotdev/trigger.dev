import { z } from "zod";

export type IntegrationAuthentication = Record<
  string,
  AuthenticationDefinition
>;

type AuthenticationDefinition = OAuth2;

interface OAuth2 {
  type: "oauth2";
  placement: AuthenticationPlacement;
  authorizationUrl: string;
  tokenUrl: string;
  flow: "accessCode" | "implicit" | "password" | "application";
  scopes: Record<string, string>;
}

type AuthenticationPlacement = HeaderAuthentication;

interface HeaderAuthentication {
  in: "header";
  type: "basic" | "bearer";
  key: string;
}

const OAuth2CredentialsSchema = z.object({
  type: z.literal("oauth2"),
  name: z.string(),
  accessToken: z.string(),
  scopes: z.array(z.string()),
});

const APIKeyCredentialsSchema = z.object({
  type: z.literal("api_key"),
  name: z.string(),
  api_key: z.string(),
  additionalFields: z.record(z.string(), z.string()).optional(),
  scopes: z.array(z.string()),
});

export const AuthCredentialsSchema = z.discriminatedUnion("type", [
  OAuth2CredentialsSchema,
  APIKeyCredentialsSchema,
]);

export type AuthCredentials = z.infer<typeof AuthCredentialsSchema>;
