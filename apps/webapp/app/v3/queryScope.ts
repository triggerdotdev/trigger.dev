import type { ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import type { QueryScope } from "~/v3/querySchemas";

/**
 * How a credential's requested query scope is handled on the query API.
 *
 * `executeQuery` always isolates by organization and widens or narrows from there on the
 * caller's `scope`. On the query API every credential reads its own environment:
 * - `environment`: public access tokens, the deprecated public key and run tokens. A
 *   project or organization scope is refused.
 * - `unbounded`: secret API keys, including additional keys. A project or organization
 *   scope is answered for the key's own environment. The query dashboards API also
 *   accepts these credentials.
 *
 * A session or PAT caller (the Query page) never goes through this: it picks its scope in
 * the UI, authorized by organization membership.
 */
export type QueryScopeCeiling = "environment" | "unbounded";

export type QueryScopeDecision = { ok: true; scope: QueryScope } | { ok: false; error: string };

/**
 * The scope an API query runs at: always the credential's own environment. A token capped
 * at `environment` that asks for a wider scope is refused; a secret key's wider request is
 * answered for its own environment. Wider scopes are available on the dashboard's Query page.
 */
export function resolveQueryScope(args: {
  ceiling: QueryScopeCeiling;
  requested: QueryScope;
}): QueryScopeDecision {
  if (args.requested === "environment" || args.ceiling === "unbounded") {
    return { ok: true, scope: "environment" };
  }
  return {
    ok: false,
    error: `This token is scoped to one environment, so it can't run a ${args.requested}-scoped query. Use scope "environment".`,
  };
}

/**
 * Public credentials and run tokens are environment-bound. Additional keys are secret keys;
 * their abilities still gate query access. `PUBLIC` is the deprecated
 * `pk_*` key — same threat model as a public access token, so it caps the same way. It cannot
 * reach the query API today (the bearer resolver 401s `pk_*`), which is why capping it costs
 * no caller anything and why the helper must not promise it is uncapped.
 */
export function queryScopeCeilingFor(
  authentication: Pick<ApiAuthenticationResultSuccess, "type" | "credentialKind">
): QueryScopeCeiling {
  return authentication.type === "PRIVATE" && authentication.credentialKind !== "run_token"
    ? "unbounded"
    : "environment";
}
