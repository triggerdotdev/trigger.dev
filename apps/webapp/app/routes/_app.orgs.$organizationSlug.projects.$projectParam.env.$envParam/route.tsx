import { Outlet } from "@remix-run/react";
import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { DashboardAgent } from "~/components/dashboard-agent/DashboardAgent";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { updateCurrentProjectEnvironmentId } from "~/services/dashboardPreferences.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { tenantContext } from "~/services/tenantContext.server";
import { EnvironmentParamSchema, v3ProjectPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      slug: projectParam,
      organization: {
        slug: organizationSlug,
        members: {
          some: {
            userId: user.id,
          },
        },
      },
      deletedAt: null,
    },
    select: {
      id: true,
      externalRef: true,
      organization: { select: { id: true } },
      environments: {
        select: {
          id: true,
          type: true,
          slug: true,
          orgMember: {
            select: {
              userId: true,
            },
          },
        },
      },
    },
  });

  if (!project) {
    logger.error("Project not found", { params, user });
    throw new Response("Project not Found", { status: 404, statusText: "Project not found" });
  }

  const environments = project.environments.filter((env) => env.slug === envParam);
  if (environments.length === 0) {
    return redirect(v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }));
  }

  let environmentId: string | undefined = undefined;
  let environmentType: "DEVELOPMENT" | "PREVIEW" | "STAGING" | "PRODUCTION" | undefined;

  if (environments.length > 1) {
    const bestEnvironment = environments.find((env) => env.orgMember?.userId === user.id);
    if (!bestEnvironment) {
      throw new Response("Environment not Found", {
        status: 404,
        statusText: "Environment not found",
      });
    }

    environmentId = bestEnvironment.id;
    environmentType = bestEnvironment.type;
  } else {
    environmentId = environments[0].id;
    environmentType = environments[0].type;
  }

  // userId is enriched higher up in `_app/route.tsx`; only stamp tenant fields here.
  tenantContext.enrich({
    orgId: project.organization.id,
    projectId: project.id,
    projectRef: project.externalRef,
    envId: environmentId,
    envType: environmentType,
  });

  await updateCurrentProjectEnvironmentId({ user: user, projectId: project.id, environmentId });

  return project;
};

export default function Page() {
  return (
    <DashboardAgent>
      <Outlet />
    </DashboardAgent>
  );
}

// Caught here (inside the project SideMenu's Outlet) rather than at the project
// layout, so a permission denial or error on any env-scoped page renders in the
// content pane with the SideMenu intact. RouteErrorDisplay renders the
// permission panel for a 403 and the generic error otherwise.
export function ErrorBoundary() {
  return <RouteErrorDisplay />;
}
