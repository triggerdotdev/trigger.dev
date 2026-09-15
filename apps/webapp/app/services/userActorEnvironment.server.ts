/** A token signed for one environment may only act inside it; a claimless token is unaffected,
 * except a dashboard-agent token, which always carries one. Mismatches throw 403. */

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

/** An org-scoped token may act in any environment of the org, gated on live per-request membership. */
export async function assertUserActorEnvironmentAccess(
  userActor: UserActorClaims | undefined,
  environment: { id: string; organizationId: string }
): Promise<void> {
  if (!userActor) return;

  if (!userActor.organizationId) {
    assertUserActorEnvironment(userActor, environment.id);
    return;
  }

  await assertUserActorOrganizationAccess(userActor, environment.organizationId);
}

/** The organization claim alone: must name this organization, and its user must still be a member. */
export async function assertUserActorOrganizationAccess(
  userActor: UserActorClaims | undefined,
  organizationId: string
): Promise<void> {
  if (!userActor) return;

  if (userActor.organizationId !== organizationId) {
    throw forbiddenEnvironment("This token isn't scoped to that organization.");
  }

  const organization = await $replica.organization.findFirst({
    where: {
      id: organizationId,
      deletedAt: null,
      members: { some: { userId: userActor.userId } },
    },
    select: { id: true },
  });

  if (!organization) {
    throw forbiddenEnvironment("You no longer have access to that organization.");
  }
}

/** The same check for a route that names an org/project rather than one environment. */
export async function assertUserActorScope(
  userActor: UserActorClaims | undefined,
  scope: { organizationId?: string; projectId?: string; environmentId?: string },
  route?: { identityOnly?: boolean; organizationScoped?: true | "tokenOrganization" }
): Promise<void> {
  if (!userActor) return;

  const organizationId = userActor.organizationId;
  if (route?.organizationScoped && organizationId) {
    await assertOrganizationScope(userActor, organizationId, scope, route.organizationScoped);
    return;
  }

  if (!userActor.environmentId) {
    assertClaimIsOptional(userActor);
    return;
  }

  if (scope.environmentId) {
    assertUserActorEnvironment(userActor, scope.environmentId);
    return;
  }

  // A route naming nothing can't honour the claim, so it's unreachable unless identity-only.
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

/** Resolves the organization from whatever the route names; nothing named is only reachable via `"tokenOrganization"`. */
async function assertOrganizationScope(
  userActor: UserActorClaims,
  organizationId: string,
  scope: { organizationId?: string; projectId?: string; environmentId?: string },
  mode: true | "tokenOrganization"
): Promise<void> {
  if (scope.environmentId) {
    const environment = await $replica.runtimeEnvironment.findFirst({
      where: { id: scope.environmentId },
      select: { organizationId: true },
    });
    if (!environment) {
      throw forbiddenEnvironment("This token isn't scoped to that organization.");
    }
    await assertUserActorOrganizationAccess(userActor, environment.organizationId);
    return;
  }

  if (scope.projectId) {
    const project = await $replica.project.findFirst({
      where: { id: scope.projectId, deletedAt: null },
      select: { organizationId: true },
    });
    if (!project) {
      throw forbiddenEnvironment("This token isn't scoped to that organization.");
    }
    await assertUserActorOrganizationAccess(userActor, project.organizationId);
    return;
  }

  if (scope.organizationId) {
    await assertUserActorOrganizationAccess(userActor, scope.organizationId);
    return;
  }

  if (mode !== "tokenOrganization") {
    throw forbiddenEnvironment("This token is scoped to an organization this route doesn't name.");
  }

  await assertUserActorOrganizationAccess(userActor, organizationId);
}

/** A `"tokenOrganization"` route scopes by the claim alone, so a claimless caller has no scope. */
export function assertTokenOrganizationClaim(userActor: UserActorClaims | undefined): void {
  if (userActor?.organizationId) return;

  throw forbiddenEnvironment("This route requires a token scoped to an organization.");
}

/** `scoped: false` keeps the project-wide answer every claimless caller already gets. */
export type UserActorEnvironmentScope =
  | { scoped: false }
  | { scoped: true; environmentId: string; slug: string; organizationId: string };

/** The claim as a mandatory filter for listing across a project; a conflicting filter is refused. */
export async function resolveUserActorEnvironmentScope(
  userActor: UserActorClaims | undefined,
  target: { projectId: string; requestedEnvironmentSlugs?: string[] },
  route?: { organizationScoped?: boolean }
): Promise<UserActorEnvironmentScope> {
  if (!userActor) return { scoped: false };

  // Org-scoped routes already checked the claim against the project's organization, so every
  // project of that org is answered project-wide; the environment claim narrows nothing here.
  if (route?.organizationScoped && userActor.organizationId) {
    return { scoped: false };
  }

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
  // An organization claim is a scope of its own; a route that doesn't check it can't honour it.
  if (userActor.organizationId) {
    throw forbiddenEnvironment("This token is scoped to an organization this route doesn't name.");
  }
  if (userActor.client !== DASHBOARD_AGENT_CLIENT) return;
  throw forbiddenEnvironment("This token isn't scoped to an environment.");
}

function forbiddenEnvironment(error: string) {
  return json({ error, code: FORBIDDEN_ENVIRONMENT_CODE }, { status: 403 });
}
