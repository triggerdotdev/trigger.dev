import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { findProjectBySlug } from "~/models/project.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";
import {
  EnvironmentParamSchema,
  v3NewProjectAlertPath,
  v3NewProjectAlertPathConnectToSlackPath,
} from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const shouldReinstall = url.searchParams.get("reinstall") === "true";
  const requestedReturnTo = url.searchParams.get("returnTo");
  const returnTo = sanitizeRedirectPath(requestedReturnTo, "") || undefined;

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  // Find an integration for Slack for this org
  let integration;
  try {
    integration = await prisma.organizationIntegration.findFirst({
      where: {
        service: "SLACK",
        organizationId: project.organizationId,
        deletedAt: null,
      },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to look up the Slack integration", {
      organizationId: project.organizationId,
      projectId: project.id,
      userId,
      error,
    });
    throw error;
  }

  // If integration exists and we're not reinstalling, redirect back to alerts
  if (integration && !shouldReinstall) {
    return redirectWithSuccessMessage(
      returnTo ??
        `${v3NewProjectAlertPath({ slug: organizationSlug }, project, {
          slug: envParam,
        })}?option=slack`,
      request,
      "Successfully connected your Slack workspace"
    );
  }

  // Redirect to Slack for new installation or reinstallation
  return await OrgIntegrationRepository.redirectToAuthService(
    "SLACK",
    project.organizationId,
    userId,
    request,
    `${v3NewProjectAlertPathConnectToSlackPath({ slug: organizationSlug }, project, {
      slug: envParam,
    })}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`
  );
}
