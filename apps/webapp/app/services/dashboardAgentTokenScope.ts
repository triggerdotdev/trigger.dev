/**
 * Org-wide tokens allow any environment in their org (default: the token's own); legacy
 * tokens are pinned to one. `organizationId` comes back so the caller still checks it.
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
