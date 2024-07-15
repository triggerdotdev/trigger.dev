import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import {
  redirectBackWithSuccessMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { findProjectBySlug } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import { getUserSession } from "~/services/sessionStorage.server";
import {
  ProjectParamSchema,
  v3NewProjectAlertPath,
  v3NewProjectAlertPathConnectToSlackPath,
} from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  // Find an integration for Slack for this org
  const integration = await prisma.organizationIntegration.findFirst({
    where: {
      service: "SLACK",
      organizationId: project.organizationId,
    },
  });

  if (integration) {
    return redirectWithSuccessMessage(
      `${v3NewProjectAlertPath({ slug: organizationSlug }, project)}?option=slack`,
      request,
      "Successfully connected your Slack workspace"
    );
  } else {
    // Redirect to Slack
    return await OrgIntegrationRepository.redirectToAuthService(
      "SLACK",
      project.organizationId,
      request,
      v3NewProjectAlertPathConnectToSlackPath({ slug: organizationSlug }, project)
    );
  }
}
