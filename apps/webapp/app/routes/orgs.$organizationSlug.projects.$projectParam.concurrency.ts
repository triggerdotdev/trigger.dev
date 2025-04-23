import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import { ProjectParamSchema, v3QueuesPath } from "~/utils/pathBuilder";

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
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const selector = new SelectBestEnvironmentPresenter();
  const environment = await selector.selectBestEnvironment(project.id, user, project.environments);

  return redirect(v3QueuesPath({ slug: organizationSlug }, project, environment));
};
