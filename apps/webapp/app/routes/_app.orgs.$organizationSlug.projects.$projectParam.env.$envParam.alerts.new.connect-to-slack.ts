import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { findProjectBySlug } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  ProjectParamSchema,
  v3NewProjectAlertPath,
  v3NewProjectAlertPathConnectToSlackPath,
} from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

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
      `${v3NewProjectAlertPath({ slug: organizationSlug }, project, {
        slug: envParam,
      })}?option=slack`,
      request,
      "Successfully connected your Slack workspace"
    );
  } else {
    // Redirect to Slack
    return await OrgIntegrationRepository.redirectToAuthService(
      "SLACK",
      project.organizationId,
      request,
      v3NewProjectAlertPathConnectToSlackPath({ slug: organizationSlug }, project, {
        slug: envParam,
      })
    );
  }
}
