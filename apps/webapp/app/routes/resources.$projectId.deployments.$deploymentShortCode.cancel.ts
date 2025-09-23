import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/node";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { DeploymentService } from "~/v3/services/deployment.server";

export const promoteSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  projectId: z.string(),
  deploymentShortCode: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { projectId, deploymentShortCode } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: promoteSchema });

  if (!submission.value) {
    return json(submission);
  }

  const verifyProjectMembership = fromPromise(
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
  const result = await verifyProjectMembership
    .andThen(findDeploymentFriendlyId)
    .andThen((deployment) =>
      deploymentService.cancelDeployment({ projectId: deployment.projectId }, deployment.friendlyId)
    );

  if (result.isErr()) {
    logger.error(
      `Failed to promote deployment: ${result.error.type}`,
      result.error.type === "other"
        ? {
            cause: result.error.cause,
          }
        : undefined
    );

    switch (result.error.type) {
      case "project_not_found":
        return redirectWithErrorMessage(submission.value.redirectUrl, request, "Project not found");
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
          "Deployment not found"
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
};
