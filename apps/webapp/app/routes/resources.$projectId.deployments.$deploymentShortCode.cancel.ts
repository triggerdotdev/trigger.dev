import { parseWithZod } from "@conform-to/zod";
import { json } from "@remix-run/node";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { DeploymentService } from "~/v3/services/deployment.server";

export const cancelSchema = z.object({
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
    const userId = user.id;

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: cancelSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    const verifyProjectMembership = () =>
      fromPromise(
        prisma.project.findFirst({
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
          select: {
            id: true,
          },
        }),
        (error) => ({ type: "other" as const, cause: error })
      ).andThen((project) => {
        if (!project) {
          return errAsync({ type: "project_not_found" as const });
        }
        return okAsync(project);
      });

    const findDeploymentFriendlyId = ({ id }: { id: string }) =>
      fromPromise(
        prisma.workerDeployment.findUnique({
          select: {
            friendlyId: true,
            projectId: true,
          },
          where: {
            projectId_shortCode: {
              projectId: id,
              shortCode: deploymentShortCode,
            },
          },
        }),
        (error) => ({ type: "other" as const, cause: error })
      ).andThen((deployment) => {
        if (!deployment) {
          return errAsync({ type: "deployment_not_found" as const });
        }
        return okAsync(deployment);
      });

    const deploymentService = new DeploymentService();
    const result = await verifyProjectMembership()
      .andThen(findDeploymentFriendlyId)
      .andThen((deployment) =>
        deploymentService.cancelDeployment(
          { projectId: deployment.projectId },
          deployment.friendlyId
        )
      );

    if (result.isErr()) {
      logger.error(
        `Failed to cancel deployment: ${result.error.type}`,
        result.error.type === "other"
          ? {
              cause: result.error.cause,
            }
          : undefined
      );

      switch (result.error.type) {
        case "project_not_found":
          return redirectWithErrorMessage(
            submission.value.redirectUrl,
            request,
            "Project not found"
          );
        case "deployment_not_found":
          return redirectWithErrorMessage(
            submission.value.redirectUrl,
            request,
            "Deployment not found"
          );
        case "deployment_cannot_be_cancelled":
          return redirectWithErrorMessage(
            submission.value.redirectUrl,
            request,
            "Deployment is already in a final state and cannot be canceled"
          );
        case "failed_to_delete_deployment_timeout":
          // not a critical error, ignore
          return redirectWithSuccessMessage(
            submission.value.redirectUrl,
            request,
            `Canceled deployment ${deploymentShortCode}.`
          );
        case "other":
        default:
          result.error.type satisfies "other";
          return redirectWithErrorMessage(
            submission.value.redirectUrl,
            request,
            "Internal server error"
          );
      }
    }

    return redirectWithSuccessMessage(
      submission.value.redirectUrl,
      request,
      `Canceled deployment ${deploymentShortCode}.`
    );
  }
);
