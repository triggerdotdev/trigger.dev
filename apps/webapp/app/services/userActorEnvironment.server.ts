import { json } from "@remix-run/server-runtime";
import { type RbacAbility, scopesWithinAbility, type UserActorClaims } from "@trigger.dev/rbac";
import { $replica } from "~/db.server";

/** The code returned when a token's environment scope doesn't cover the requested environment. */
export const FORBIDDEN_ENVIRONMENT_CODE = "forbidden_environment";

/** The agent always mints per-environment, so a claimless token of its own is a bug, not a flow. */
const DASHBOARD_AGENT_CLIENT = "dashboard-agent";

/**
 * A user-actor token is signed for one environment. Honouring it against another environment
 * would break that signed scope, widening a leaked token to every environment its user can reach.
 *
 * Throws a 403 Response on mismatch. A PAT, an org token or an environment-agnostic UAT flow
 * (the public PAT exchange, used by MCP and the CLI) carries no claim and is unaffected — but a
 * dashboard-agent token without one is refused, so a mint that failed to resolve an environment
 * cannot produce a token that passes every gate.
 */
export function assertUserActorEnvironment(
  userActor: UserActorClaims | undefined,
  environmentId: string
): void {
  if (!userActor) return;
  if (!userActor.environmentId) {
    assertClaimIsOptional(userActor);
    return;
  }
  if (userActor.environmentId === environmentId) return;

  throw forbiddenEnvironment("This token isn't scoped to that environment.");
}

/**
 * The same check for a route that names an org/project rather than one environment — the shape a
 * route builder's `context` resolves. A token signed for one environment may only act inside that
 * environment's project and org, so a URL naming a different tenant fails closed here rather than
 * relying on each route to notice.
 */
export async function assertUserActorScope(
  userActor: UserActorClaims | undefined,
  scope: { organizationId?: string; projectId?: string; environmentId?: string }
): Promise<void> {
  if (!userActor) return;

  if (!userActor.environmentId) {
    assertClaimIsOptional(userActor);
    return;
  }

  if (scope.environmentId) {
    assertUserActorEnvironment(userActor, scope.environmentId);
    return;
  }

  if (!scope.organizationId && !scope.projectId) return;

  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: userActor.environmentId },
    select: { organizationId: true, projectId: true },
  });

  // A claim naming an environment that no longer exists cannot be checked, so it isn't honoured.
  if (!environment) {
    throw forbiddenEnvironment("This token isn't scoped to an environment.");
  }
  if (scope.projectId && environment.projectId !== scope.projectId) {
    throw forbiddenEnvironment("This token isn't scoped to that project.");
  }
  if (scope.organizationId && environment.organizationId !== scope.organizationId) {
    throw forbiddenEnvironment("This token isn't scoped to that organization.");
  }
}

/**
 * The environment a project-wide route must narrow to. `scoped: false` is every caller with no
 * environment claim to narrow to — a session, a PAT, an org token, or an environment-agnostic
 * UAT — and stays project-wide, unchanged.
 */
export type UserActorEnvironmentScope =
  | { scoped: false }
  | { scoped: true; environmentId: string; slug: string; organizationId: string };

/**
 * Turns a user-actor token's environment claim into a mandatory filter for a route that lists
 * across a project. Without this, an environment-scoped token reads every environment its user
 * is a member of — the claim would only bind the per-environment routes.
 *
 * Throws a 403 Response when a claim can't be honoured: a claim outside the target project, or a
 * request filter that names anything else. A conflicting filter is refused rather than overridden,
 * so a caller never gets another environment's shape of answer under its own filter. A token with
 * no claim keeps the project-wide answer — narrowing it would break the public PAT exchange, which
 * mints claimless tokens. A dashboard-agent token always carries one, so its absence is a bug.
 */
export async function resolveUserActorEnvironmentScope(
  userActor: UserActorClaims | undefined,
  target: { projectId: string; requestedEnvironmentSlugs?: string[] }
): Promise<UserActorEnvironmentScope> {
  if (!userActor) return { scoped: false };

  if (!userActor.environmentId) {
    assertClaimIsOptional(userActor);
    return { scoped: false };
  }

  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: userActor.environmentId, projectId: target.projectId },
    select: { id: true, slug: true, organizationId: true },
  });

  // A claim naming an environment that can't be found in this project isn't honoured.
  if (!environment) {
    throw forbiddenEnvironment("This token isn't scoped to that project.");
  }

  const requested = target.requestedEnvironmentSlugs;
  if (requested && (requested.length !== 1 || requested[0] !== environment.slug)) {
    throw forbiddenEnvironment(`This token is scoped to the "${environment.slug}" environment.`);
  }

  return {
    scoped: true,
    environmentId: environment.id,
    slug: environment.slug,
    organizationId: environment.organizationId,
  };
}

/** Read-only default for a delegated token that declares no cap — mirrors the RBAC fallback. */
const CAPLESS_USER_ACTOR_SCOPES = ["read:all"];

/**
 * Ceilings the scopes of a credential minted from a user-actor token by what the token's own
 * actor can do. A delegated token must never mint something more capable than itself, so its
 * ability — not the request — is the ceiling, and a capless token is read-only.
 */
export function clampUserActorScopes(
  requestedScopes: string[] | undefined,
  userActor: UserActorClaims,
  ability: RbacAbility
): { scopes: string[]; deniedScopes: string[] } {
  const requested =
    requestedScopes && requestedScopes.length > 0
      ? requestedScopes
      : (userActor.cap ?? CAPLESS_USER_ACTOR_SCOPES);

  const { deniedScopes } = scopesWithinAbility(requested, ability);

  return { scopes: requested.filter((scope) => !deniedScopes.includes(scope)), deniedScopes };
}

/** A dashboard-agent token always carries the claim; any other flow may be environment-agnostic. */
function assertClaimIsOptional(userActor: UserActorClaims): void {
  if (userActor.client !== DASHBOARD_AGENT_CLIENT) return;
  throw forbiddenEnvironment("This token isn't scoped to an environment.");
}

function forbiddenEnvironment(error: string) {
  return json({ error, code: FORBIDDEN_ENVIRONMENT_CODE }, { status: 403 });
}
