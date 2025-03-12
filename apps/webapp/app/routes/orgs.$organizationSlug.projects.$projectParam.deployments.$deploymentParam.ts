import { redirect } from "@remix-run/router";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, v3DeploymentPath } from "~/utils/pathBuilder";

const ParamSchema = ProjectParamSchema.extend({
  deploymentParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireUserId(request);
  const { organizationSlug, projectParam, deploymentParam } = ParamSchema.parse(params);

  const deployment = await prisma.workerDeployment.findFirst({
    where: {
      shortCode: deploymentParam,
      project: {
        slug: projectParam,
      },
    },
    select: {
      environment: true,
    },
  });

  if (!deployment) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(
    v3DeploymentPath(
      {
        slug: organizationSlug,
      },
      { slug: projectParam },
      { slug: deployment.environment.slug },
      { shortCode: deploymentParam },
      0
    )
  );
};
