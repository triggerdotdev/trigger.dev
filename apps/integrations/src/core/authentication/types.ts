export type IntegrationAuthentication = Record<
string,
AuthenticationDefinition
>

type AuthenticationDefinition = OAuth2

interface OAuth2 {
  type: "oauth2";
  placement: AuthenticationPlacement
  authorizationUrl: string
  tokenUrl: string
  flow: "accessCode" | "implicit" | "password" | "application";
  scopes: Record<string, string>
}

type AuthenticationPlacement = HeaderAuthentication

interface HeaderAuthentication {
  in: "header";
  type: "basic" | "bearer";
  key: string
}

export type AuthCredentials = OAuth2Credentials | APIKeyCredentials

interface OAuth2Credentials {
  type: "oauth2";
  name: string
  accessToken: string
  scopes: string[]
}
interface APIKeyCredentials {
  type: "api_key";
  name: string
  api_key: string
  additionalFields?: Record<string, string>
  scopes: string[]
}
