// Run tokens use their own key set and issuer. The distinct audience and `typ` are a second check.
export const RUN_TOKEN_TYPE = "run+jwt";
export const RUN_TOKEN_AUDIENCE = "trigger:api";
export const RUN_TOKEN_USE = "run";
export const RUN_TOKEN_TTL_SECONDS = 60 * 60;

// Environment tenancy is enforced when authenticating and resolving each route's target.
export function runTokenScopes(): string[] {
  return ["admin"];
}
