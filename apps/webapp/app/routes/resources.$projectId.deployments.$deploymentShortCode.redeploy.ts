import { parseWithZod } from "@conform-to/zod/v4";
import { json } from "@remix-run/node";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { sanitizeRedirectPath } from "~/utils";
import { RedeployDeploymentService } from "~/v3/services/redeployDeployment.server";

const FormSchema = z.object({
  redirectUrl: z.string(),
  promote: z.preprocess((value) => value === "on", z.boolean()),
});

const ParamSchema = z.object({
  projectId: z.string(),
  deploymentShortCode: z.string(),
});

export const action = dashboardAction(
  {
    params: ParamSchema,
    context: async (params) => {
      const project = await $replica.project.findFirst({
        where: { id: params.projectId },
        select: { organizationId: true },
      });
      return project ? { organizationId: project.organizationId, projectId: params.projectId } : {};
    },
    authorization: { action: "write", resource: { type: "deployments" } },
  },
  async ({ request, params, user }) => {
    const { projectId, deploymentShortCode } = params;

    const submission = parseWithZod(await request.formData(), { schema: FormSchema });
    if (submission.status !== "success") {
      return json(submission.reply());
    }
    const redirectUrl = sanitizeRedirectPath(submission.value.redirectUrl);

    const project = await prisma.project.findFirst({
      where: { id: projectId, organization: { members: { some: { userId: user.id } } } },
      select: { id: true },
    });
    if (!project) {
      return redirectWithErrorMessage(redirectUrl, request, "Project not found");
    }

    const result = await new RedeployDeploymentService().call({
      userId: user.id,
      projectId: project.id,
      deploymentShortCode,
      skipPromotion: !submission.value.promote,
    });

    if (result.isErr()) {
      if (result.error.type === "other") {
        logger.error("Failed to redeploy deployment", {
          projectId: project.id,
          deploymentShortCode,
          cause: result.error.cause,
        });
      } else {
        logger.warn(`Redeploy rejected: ${result.error.type}`, {
          projectId: project.id,
          deploymentShortCode,
        });
      }

      switch (result.error.type) {
        case "deployment_in_flight":
          return redirectWithErrorMessage(
            redirectUrl,
            request,
            "Another deployment is already in progress in this environment"
          );
        case "atomic_production":
          return redirectWithErrorMessage(
            redirectUrl,
            request,
            "This environment is deployed together with Vercel. Deploy it from Vercel."
          );
        case "deployment_not_found":
          return redirectWithErrorMessage(redirectUrl, request, "Deployment not found");
        case "deployment_not_redeployable":
          return redirectWithErrorMessage(
            redirectUrl,
            request,
            "This deployment can't be redeployed"
          );
        case "deployment_expired":
          return redirectWithErrorMessage(
            redirectUrl,
            request,
            "This deployment is too old to be redeployed"
          );
        case "failed_to_enqueue_build":
          return redirectWithErrorMessage(redirectUrl, request, result.error.message);
        case "other":
        default:
          result.error.type satisfies "other";
          return redirectWithErrorMessage(redirectUrl, request, "Failed to redeploy");
      }
    }

    return redirectWithSuccessMessage(
      redirectUrl,
      request,
      `Redeploying as version ${result.value.version}`
    );
  }
);
