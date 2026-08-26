/**
 * Which environment a dashboard-agent turn may act in, from the token's claims alone.
 *
 * An org-wide token draws the boundary at its organization: the request may name any
 * environment inside it, and the token's own environment is only the default when it names
 * none. `organizationId` comes back with the target, for the caller to check the resolved
 * environment against — a request id is never authorization on its own.
 *
 * A token with no organization is the legacy environment-pinned form: its one environment,
 * which the request can echo but never replace.
 */

export type AgentTokenScope =
  | {
      ok: true;
      environmentId: string;
      /** Set only for an org-wide token: the org the environment must belong to. */
      organizationId?: string;
    }
  | { ok: false; code: "invalid_target"; error: string };

export function resolveAgentTokenScope(
  claims: { environmentId?: string; organizationId?: string },
  requested: { environmentId?: string }
): AgentTokenScope {
  if (claims.organizationId) {
    const environmentId = requested.environmentId ?? claims.environmentId;
    if (!environmentId) {
      return {
        ok: false,
        code: "invalid_target",
        error: "Name the environment to use, as `environmentId`.",
      };
    }
    return { ok: true, environmentId, organizationId: claims.organizationId };
  }

  if (claims.environmentId) {
    return { ok: true, environmentId: claims.environmentId };
  }

  return {
    ok: false,
    code: "invalid_target",
    error: "This chat has no environment context.",
  };
}
