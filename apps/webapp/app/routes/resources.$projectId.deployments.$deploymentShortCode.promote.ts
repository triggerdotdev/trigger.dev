import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";

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

  try {
    const project = await prisma.project.findUnique({
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

    if (!project) {
      return redirectWithErrorMessage(submission.value.redirectUrl, request, "Project not found");
    }

    const deployment = await prisma.workerDeployment.findUnique({
      where: {
        projectId_shortCode: {
          projectId: project.id,
          shortCode: deploymentShortCode,
        },
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
      submission.error = { runParam: error.message };
      return json(submission);
    } else {
      logger.error("Failed to promote deployment", { error });
      submission.error = { runParam: JSON.stringify(error) };
      return json(submission);
    }
  }
};
