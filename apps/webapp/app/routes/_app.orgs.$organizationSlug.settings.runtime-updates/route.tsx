import { NODE_RUNTIME_UPDATE_MAJOR } from "@trigger.dev/core/v3";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { resolveOrgIdFromSlugForUser } from "~/models/organization.server";
import { listCurrentProductionProjectRuntimes } from "~/services/projectRuntimeUpdates.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getUserId } from "~/services/session.server";
import { pageMeta } from "~/utils/pageTitle";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";
import { type ProjectRuntimeRow, RuntimeUpdatesPage } from "./RuntimeUpdatesPage";

export const meta = pageMeta("Projects");

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    // Membership-scoped resolve, like the Team settings loader: the RBAC gate below enforces the
    // role, this is the tenant floor. An unresolved org yields no scope, which fails closed.
    context: async (params, request) => {
      const userId = await getUserId(request);
      if (!userId) return {};
      const organizationId = await resolveOrgIdFromSlugForUser(params.organizationSlug, userId);
      return organizationId ? { organizationId } : {};
    },
    authorization: {
      action: "read",
      resource: { type: "deployments" },
      message: "With your current role, you can't view project deployments.",
    },
  },
  async ({ context, params }) => {
    const runtimes = await listCurrentProductionProjectRuntimes({
      organizationId: context.organizationId,
    });

    const needsUpdate: ProjectRuntimeRow[] = [];
    const otherProjects: ProjectRuntimeRow[] = [];

    for (const { project, environment, deployment } of runtimes) {
      const row: ProjectRuntimeRow = {
        name: project.name,
        ref: project.externalRef,
        slug: project.slug,
        environmentSlug: environment.slug,
        deployment: deployment
          ? {
              runtime: deployment.runtime,
              runtimeVersion: deployment.runtimeVersion,
              deployedAt: deployment.deployedAt,
              shortCode: deployment.shortCode,
            }
          : null,
      };

      if (deployment?.nodeMajor === NODE_RUNTIME_UPDATE_MAJOR) {
        needsUpdate.push(row);
      } else {
        otherProjects.push(row);
      }
    }

    return typedjson({
      organizationSlug: params.organizationSlug,
      needsUpdate,
      otherProjects,
    });
  }
);

export default function Page() {
  const { organizationSlug, needsUpdate, otherProjects } = useTypedLoaderData<typeof loader>();

  return (
    <RuntimeUpdatesPage
      organizationSlug={organizationSlug}
      needsUpdate={needsUpdate}
      otherProjects={otherProjects}
    />
  );
}
