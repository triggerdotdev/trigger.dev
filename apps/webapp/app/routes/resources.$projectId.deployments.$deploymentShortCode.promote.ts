import { parseWithZod } from "@conform-to/zod";
import { json } from "@remix-run/node";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";

export const promoteSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  projectId: z.string(),
  deploymentShortCode: z.string(),
});

async function resolveOrgIdFromProjectId(projectId: string): Promise<string | null> {
  const project = await $replica.project.findFirst({
    where: { id: projectId },
    select: { organizationId: true },
  });
  return project?.organizationId ?? null;
}

export const action = dashboardAction(
  {
    params: ParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromProjectId(params.projectId);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "write", resource: { type: "deployments" } },
  },
  async ({ request, params, user }) => {
    const { projectId, deploymentShortCode } = params;

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: promoteSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    try {
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          organization: {
            members: {
              some: {
                userId: user.id,
              },
            },
          },
        },
      });

      if (!project) {
        return redirectWithErrorMessage(submission.value.redirectUrl, request, "Project not found");
      }

      const deployment = await prisma.workerDeployment.findFirst({
        where: {
          projectId: project.id,
          shortCode: deploymentShortCode,
        },
      });

      if (!deployment) {
        return redirectWithErrorMessage(
          submission.value.redirectUrl,
          request,
          "Deployment not found"
        );
      }

      const promoteService = new ChangeCurrentDeploymentService();
      await promoteService.call(deployment, "promote");

      return redirectWithSuccessMessage(
        submission.value.redirectUrl,
        request,
        `Promoted deployment version ${deployment.version} to current.`
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error("Failed to promote deployment", {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
        return json(submission.reply({ formErrors: [error.message] }));
      } else {
        logger.error("Failed to promote deployment", { error });
        return json(submission.reply({ formErrors: [JSON.stringify(error)] }));
      }
    }
  }
);
