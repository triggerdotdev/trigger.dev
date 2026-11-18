import { env } from "~/env.server";

/** The UAT cap vocabulary the MCP tools check. */
export const MCP_SCOPES: readonly string[] = [
  "read:alerts",
  "read:branches",
  "read:deployments",
  "read:organizations",
  "read:projects",
  "read:prompts",
  "read:query",
  "read:runs",
  "read:sessions",
  "read:webhooks",
  "trigger:tasks",
  "update:prompts",
  "write:alerts",
  "write:projects",
  "write:query",
  "write:runs",
  "write:sessions",
  "write:webhooks",
];

export function mcpResource() {
  return `${env.MCP_ORIGIN}/mcp`;
}

export function authorizationServerMetadata() {
  return {
    issuer: env.APP_ORIGIN,
    authorization_endpoint: `${env.APP_ORIGIN}/oauth/authorize`,
    token_endpoint: `${env.APP_ORIGIN}/oauth/token`,
    registration_endpoint: `${env.APP_ORIGIN}/oauth/register`,
    revocation_endpoint: `${env.APP_ORIGIN}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "access_denied";

export type OAuthError = { error: OAuthErrorCode; error_description: string };

export function oauthError(error: OAuthErrorCode, error_description: string): OAuthError {
  return { error, error_description };
}

/** Parses a space-delimited scope; absent means every read scope. Null when any is unknown. */
export function parseScope(scope: string | null | undefined): string[] | null {
  if (!scope?.trim()) return MCP_SCOPES.filter((s) => s.startsWith("read:"));
  const requested = [...new Set(scope.trim().split(/\s+/))];
  return requested.every((s) => MCP_SCOPES.includes(s)) ? requested : null;
}
