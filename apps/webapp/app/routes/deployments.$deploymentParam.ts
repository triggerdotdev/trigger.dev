import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { rootPath, v3DeploymentPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  deploymentParam: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { deploymentParam } = ParamsSchema.parse(params);

  const deployment = await prisma.workerDeployment.findFirst({
    where: {
      friendlyId: deploymentParam,
      project: {
        organization: {
          members: {
            some: {
              userId: user.id,
            },
          },
        },
      },
    },
    select: {
      shortCode: true,
      environment: {
        select: {
          slug: true,
        },
      },
      project: {
        select: {
          slug: true,
          organization: {
            select: {
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!deployment) {
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "Deployment either doesn't exist or you don't have permission to view it",
      {
        ephemeral: false,
      }
    );
  }

  return redirect(
    v3DeploymentPath(
      { slug: deployment.project.organization.slug },
      { slug: deployment.project.slug },
      { slug: deployment.environment.slug },
      { shortCode: deployment.shortCode },
      0
    )
  );
}
