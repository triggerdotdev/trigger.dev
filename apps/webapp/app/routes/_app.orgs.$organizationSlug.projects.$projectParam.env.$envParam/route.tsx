import { Outlet } from "@remix-run/react";
import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { updateCurrentProjectEnvironmentId } from "~/services/dashboardPreferences.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
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

  if (environments.length > 1) {
    const bestEnvironment = environments.find((env) => env.orgMember?.userId === user.id);
    if (!bestEnvironment) {
      throw new Response("Environment not Found", {
        status: 404,
        statusText: "Environment not found",
      });
    }

    environmentId = bestEnvironment.id;
  } else {
    environmentId = environments[0].id;
  }

  await updateCurrentProjectEnvironmentId({ user: user, projectId: project.id, environmentId });

  return project;
};

export default function Page() {
  return <Outlet />;
}
