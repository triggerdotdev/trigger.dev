import { type PrismaClientOrTransaction, RuntimeEnvironmentType } from "@trigger.dev/database";
import type { HostRbacController } from "@trigger.dev/rbac";
import { throwPermissionDenied } from "~/utils/permissionDenied";

export async function dashboardResourceAccess(
  database: PrismaClientOrTransaction,
  controller: Pick<HostRbacController, "authenticateSession">,
  request: Request,
  userId: string,
  scope: { organizationId: string; projectId?: string; environmentId?: string }
) {
  const organization = await database.organization.findFirst({
    where: { id: scope.organizationId, deletedAt: null, members: { some: { userId } } },
    select: { id: true },
  });
  if (!organization) throw new Response("Organization not found", { status: 404 });
  // Both lookups depend only on the validated organization and supplied scope.
  const [project, environment] = await Promise.all([
    scope.projectId
      ? database.project.findFirst({
          where: { id: scope.projectId, organizationId: organization.id, deletedAt: null },
          select: { id: true },
        })
      : undefined,
    scope.environmentId
      ? database.runtimeEnvironment.findFirst({
          where: {
            id: scope.environmentId,
            organizationId: organization.id,
            projectId: scope.projectId,
            archivedAt: null,
            project: { deletedAt: null },
          },
          select: { id: true, type: true, projectId: true },
        })
      : undefined,
  ]);
  if (scope.projectId && !project) throw new Response("Project not found", { status: 404 });
  if (scope.environmentId && !environment)
    throw new Response("Environment not found", { status: 404 });
  const auth = await controller.authenticateSession(request, {
    userId,
    organizationId: organization.id,
    projectId: environment?.projectId ?? scope.projectId,
  });
  if (!auth.ok) throwPermissionDenied();
  const can = (action: string, type: string) =>
    auth.ability.can(action, { type, ...(environment ? { envType: environment.type } : {}) });
  const canAcrossEnvironments = (
    action: string,
    type: string,
    environmentTypes: readonly RuntimeEnvironmentType[]
  ) =>
    (environmentTypes.length ? environmentTypes : Object.values(RuntimeEnvironmentType)).every(
      (envType) => auth.ability.can(action, { type, envType })
    );
  return {
    can,
    canAcrossEnvironments,
    requireAcrossEnvironments(
      action: string,
      type: string,
      environmentTypes: readonly RuntimeEnvironmentType[]
    ) {
      if (!canAcrossEnvironments(action, type, environmentTypes))
        throwPermissionDenied("You don't have permission in every affected environment.");
    },
    require(action: string, type: string) {
      if (!can(action, type))
        throwPermissionDenied("You don't have permission to perform this action.");
    },
  };
}
