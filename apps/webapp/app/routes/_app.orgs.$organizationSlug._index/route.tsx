import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import {
  newOrganizationPath,
  newProjectPath,
  OrganizationParamsSchema,
  v3ProjectPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const org = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId: user.id } }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      projects: {
        where: { deletedAt: null, version: "V3" },
        select: {
          id: true,
          slug: true,
          name: true,
          updatedAt: true,
        },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!org) {
    throw redirect(newOrganizationPath());
  }

  const selector = new SelectBestEnvironmentPresenter();
  const bestProject = await selector.selectBestProjectFromProjects({
    user,
    projectSlug: undefined,
    projects: org.projects,
  });
  if (!bestProject) {
    logger.info("Not Found: project", {
      request,
      project: bestProject,
    });
    throw redirect(newProjectPath({ slug: organizationSlug }));
  }

  return redirect(v3ProjectPath({ slug: organizationSlug }, bestProject));
};
