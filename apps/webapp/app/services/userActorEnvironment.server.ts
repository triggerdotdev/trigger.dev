/**
 * The Dashboard Agent uses an environment-scoped form of the existing user-actor credential.
 * MCP and the CLI may use their existing ones. Both normalize into the same authorized
 * capability context, so every route calls in here rather than deriving the rule itself.
 *
 * The rule: a token signed for one environment may only act inside it. A route that names nothing
 * to check the claim against is refused too, unless it declares itself identity-only. Anything
 * with no claim is environment-agnostic and unaffected — except a dashboard-agent token, which
 * always carries one, so its absence is a failed mint rather than a flow. Mismatches throw 403.
 */

import { json } from "@remix-run/server-runtime";
import { type UserActorClaims } from "@trigger.dev/rbac";
import { $replica } from "~/db.server";

const FORBIDDEN_ENVIRONMENT_CODE = "forbidden_environment";

const DASHBOARD_AGENT_CLIENT = "dashboard-agent";

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
 * The environment gate for the JWT exchange: an environment claim still mints only for its own
 * environment, and an org claim mints for any environment of that org the user belongs to.
 */
export async function assertUserActorEnvironmentAccess(
  userActor: UserActorClaims | undefined,
  environment: { id: string; organizationId: string }
): Promise<void> {
  if (!userActor?.organizationId || userActor.environmentId === environment.id) {
    assertUserActorEnvironment(userActor, environment.id);
    return;
  }

  if (userActor.organizationId !== environment.organizationId) {
    throw forbiddenEnvironment("This token isn't scoped to that organization.");
  }

  // Membership is the tenant floor here, so it is a membership-scoped query, not an ability check.
  const membership = await $replica.organization.findFirst({
    where: {
      id: environment.organizationId,
      deletedAt: null,
      members: { some: { userId: userActor.userId } },
    },
    select: { id: true },
  });

  if (!membership) {
    throw forbiddenEnvironment("You don't have access to that organization.");
  }
}

/** The same check for a route that names an org/project rather than one environment. */
export async function assertUserActorScope(
  userActor: UserActorClaims | undefined,
  scope: { organizationId?: string; projectId?: string; environmentId?: string },
  route?: { identityOnly?: boolean }
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

  // A route that names nothing offers no way to honour the claim, so it isn't reachable unless it
  // has declared itself identity-only.
  if (!scope.organizationId && !scope.projectId) {
    if (route?.identityOnly) return;
    throw forbiddenEnvironment("This token is scoped to an environment this route doesn't name.");
  }

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

/** `scoped: false` keeps the project-wide answer every claimless caller already gets. */
export type UserActorEnvironmentScope =
  | { scoped: false }
  | { scoped: true; environmentId: string; slug: string; organizationId: string };

/**
 * The claim as a mandatory filter for a route that lists across a project. A conflicting request
 * filter is refused rather than overridden, so a caller never gets another environment's answer.
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

function assertClaimIsOptional(userActor: UserActorClaims): void {
  if (userActor.client !== DASHBOARD_AGENT_CLIENT) return;
  throw forbiddenEnvironment("This token isn't scoped to an environment.");
}

function forbiddenEnvironment(error: string) {
  return json({ error, code: FORBIDDEN_ENVIRONMENT_CODE }, { status: 403 });
}
