import { NODE_RUNTIME_UPDATE_MAJOR } from "@trigger.dev/core/v3";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { listCurrentProductionProjectRuntimes } from "~/services/projectRuntimeUpdates.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";
import { type ProjectRuntimeRow, RuntimeUpdatesPage } from "./RuntimeUpdatesPage";

export const meta = pageMeta("Projects");

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: {
      action: "read",
      resource: { type: "deployments" },
      message: "With your current role, you can't view runtime updates.",
    },
  },
  async ({ context, params }) => {
    const runtimes = await listCurrentProductionProjectRuntimes({
      organizationId: context.organizationId,
    });

    const needsUpdate: ProjectRuntimeRow[] = [];
    const upToDate: ProjectRuntimeRow[] = [];

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
        upToDate.push(row);
      }
    }

    return typedjson({
      organizationSlug: params.organizationSlug,
      needsUpdate,
      upToDate,
    });
  }
);

export default function Page() {
  const { organizationSlug, needsUpdate, upToDate } = useTypedLoaderData<typeof loader>();

  return (
    <RuntimeUpdatesPage
      organizationSlug={organizationSlug}
      needsUpdate={needsUpdate}
      upToDate={upToDate}
    />
  );
}
