import type { QueryScope } from "~/v3/querySchemas";

/**
 * The widest scope a credential may query at.
 *
 * `executeQuery` always isolates by organization and widens or narrows from there
 * on the caller's `scope`. That makes the request body, not the credential, the
 * ceiling — which is wrong for a public access token: it is minted for one
 * environment and handed to a browser, so anyone holding it could read the whole
 * organization's analytics by changing one field.
 *
 * A secret key is deliberately NOT capped here. It is a server-side credential the
 * organization's own owner installs, and capping it would change the public API's
 * behaviour for callers who query at organization scope today. A session or PAT
 * caller (the Query page) never goes through this: it picks its scope in the UI,
 * authorized by organization membership.
 */
export type QueryScopeCeiling = "environment" | "unbounded";

export type QueryScopeDecision = { ok: true; scope: QueryScope } | { ok: false; error: string };

/**
 * Rejected rather than narrowed. Silently answering about one environment when the
 * caller asked about the organization gives them a number that means something else,
 * with nothing in the response to say so.
 */
export function resolveQueryScope(args: {
  ceiling: QueryScopeCeiling;
  requested: QueryScope;
}): QueryScopeDecision {
  if (args.ceiling === "unbounded") return { ok: true, scope: args.requested };
  if (args.requested === "environment") return { ok: true, scope: "environment" };
  return {
    ok: false,
    error: `This token is scoped to one environment, so it can't run a ${args.requested}-scoped query. Use scope "environment", or a secret key.`,
  };
}

/** A public access token is environment-bound; every other bearer credential isn't. */
export function queryScopeCeilingFor(authenticationType: string): QueryScopeCeiling {
  return authenticationType === "PUBLIC_JWT" ? "environment" : "unbounded";
}
