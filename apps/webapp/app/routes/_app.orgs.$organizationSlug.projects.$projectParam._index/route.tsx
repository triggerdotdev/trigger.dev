import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import { pagePath, requestedProjectPortablePage } from "~/utils/pageSwitching";
import { ProjectParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      slug: projectParam,
      deletedAt: null,
      organization: { slug: organizationSlug, members: { some: { userId: user.id } } },
    },
    include: {
      environments: {
        where: { archivedAt: null },
        select: {
          id: true,
          type: true,
          slug: true,
          parentEnvironmentId: true,
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
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const selector = new SelectBestEnvironmentPresenter();
  const environment = await selector.selectBestEnvironment(project.id, user, project.environments);

  const environmentPath = v3EnvironmentPath({ slug: organizationSlug }, project, environment);

  return redirect(pagePath(environmentPath, requestedProjectPortablePage(request)));
};
