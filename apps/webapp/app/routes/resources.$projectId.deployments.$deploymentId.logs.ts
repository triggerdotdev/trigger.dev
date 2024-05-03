import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { ExternalBuildData } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { redirectBackWithErrorMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  projectId: z.string(),
  deploymentId: z.string(),
});

// Redirects to Depot.dev
export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { projectId, deploymentId } = ParamsSchema.parse(params);

  await prisma.project.findFirstOrThrow({
    where: {
      id: projectId,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
  });

  const deployment = await prisma.workerDeployment.findUniqueOrThrow({
    where: {
      id: deploymentId,
      projectId: projectId,
    },
  });

  const externalBuildData = deployment.externalBuildData
    ? ExternalBuildData.safeParse(deployment.externalBuildData)
    : undefined;

  if (!externalBuildData || externalBuildData.success === false) {
    return redirectBackWithErrorMessage(request, "No build data found for this deployment.");
  }

  if (!env.DEPOT_ORG_ID) {
    return redirectBackWithErrorMessage(request, "No Depot organization ID found.");
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://depot.dev/orgs/${env.DEPOT_ORG_ID}/projects/${externalBuildData.data.projectId}/builds/${externalBuildData.data.buildId}/logs`,
    },
  });
}
