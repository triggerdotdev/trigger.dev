import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { resolveOrgIdFromSlugForUser } from "~/models/organization.server";
import { listCurrentProductionProjectRuntimes } from "~/services/projectRuntimeUpdates.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getUserId } from "~/services/session.server";
import { pageMeta } from "~/utils/pageTitle";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";
import { type ProjectRuntimeRow, ProjectsPage } from "./ProjectsPage";

export const meta = pageMeta("Projects");

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    // Membership-scoped resolve, like the Team settings loader: the RBAC gate below enforces the
    // role, this is the tenant floor. An unresolved org yields no scope, which the loader rejects.
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
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }

    const runtimes = await listCurrentProductionProjectRuntimes({ organizationId });
    const projects: ProjectRuntimeRow[] = runtimes.map(({ project, environment, deployment }) => ({
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
    }));

    return typedjson({ organizationSlug: params.organizationSlug, projects });
  }
);

export default function Page() {
  const { organizationSlug, projects } = useTypedLoaderData<typeof loader>();
  return <ProjectsPage organizationSlug={organizationSlug} projects={projects} />;
}
