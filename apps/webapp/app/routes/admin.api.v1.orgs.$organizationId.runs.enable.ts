import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  type RuntimeEnvironment,
  type Organization,
  type Project,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createEnvironment } from "~/models/organization.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const BodySchema = z.object({
  enable: z.boolean(),
});

/**
 * It will enabled/disable runs
 */
export async function action({ request, params }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (!user.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  const { organizationId } = ParamsSchema.parse(params);
  const body = BodySchema.safeParse(await request.json());
  if (!body.success) {
    return json({ error: "Invalid request body", details: body.error }, { status: 400 });
  }

  const organization = await prisma.organization.update({
    where: {
      id: organizationId,
    },
    data: {
      runsEnabled: body.data.enable,
    },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  const environments = await prisma.runtimeEnvironment.findMany({
    where: {
      organizationId,
      type: {
        not: "DEVELOPMENT",
      },
    },
    include: {
      organization: true,
      project: true,
    },
  });

  const pauseEnvironmentService = new PauseEnvironmentService();

  // Set the organization.runsEnabled flag to false
  for (const environment of environments) {
    if (body.data.enable) {
      await pauseEnvironmentService.call({ ...environment, organization }, "resumed");
    } else {
      await pauseEnvironmentService.call({ ...environment, organization }, "paused");
    }
  }

  return json({
    success: true,
    message: `${environments.length} environments updated to ${
      body.data.enable ? "enabled" : "disabled"
    }`,
  });
}
