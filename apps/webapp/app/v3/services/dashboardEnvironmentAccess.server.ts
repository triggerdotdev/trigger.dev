import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { HostRbacController } from "@trigger.dev/rbac";
import { throwPermissionDenied } from "~/utils/permissionDenied";

/** Resolve tenancy on the writer before asking the optional plugin for an ability. */
export async function dashboardEnvironmentAccess(
  database: PrismaClientOrTransaction,
  controller: Pick<HostRbacController, "authenticateSession">,
  request: Request,
  userId: string,
  environmentId: string
) {
  const environment = await database.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      archivedAt: null,
      project: { deletedAt: null },
      organization: { deletedAt: null, members: { some: { userId } } },
    },
    select: { id: true, type: true, projectId: true, organizationId: true },
  });
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const auth = await controller.authenticateSession(request, {
    userId,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
  });
  if (!auth.ok) throwPermissionDenied();
  return { environment, ability: auth.ability };
}
