import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { findProjectBySlug } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3ErrorsPath,
  v3ErrorsConnectToSlackPath,
} from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const shouldReinstall = url.searchParams.get("reinstall") === "true";

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const integration = await prisma.organizationIntegration.findFirst({
    where: {
      service: "SLACK",
      organizationId: project.organizationId,
      deletedAt: null,
    },
  });

  if (integration && !shouldReinstall) {
    return redirectWithSuccessMessage(
      `${v3ErrorsPath({ slug: organizationSlug }, project, { slug: envParam })}?alerts`,
      request,
      "Successfully connected your Slack workspace"
    );
  }

  return await OrgIntegrationRepository.redirectToAuthService(
    "SLACK",
    project.organizationId,
    request,
    v3ErrorsConnectToSlackPath({ slug: organizationSlug }, project, { slug: envParam })
  );
}
