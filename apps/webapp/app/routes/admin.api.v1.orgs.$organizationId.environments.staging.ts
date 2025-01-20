import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createEnvironment } from "~/models/organization.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { marqs } from "~/v3/marqs/index.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

/**
 * It will create a staging environment for all the projects where there isn't one already
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

  const organization = await prisma.organization.findUnique({
    where: {
      id: organizationId,
    },
    include: {
      projects: {
        include: { environments: true },
      },
    },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  let created = 0;

  for (const project of organization.projects) {
    const stagingEnvironment = project.environments.find((env) => env.type === "STAGING");

    if (!stagingEnvironment) {
      const staging = await createEnvironment(organization, project, "STAGING");
      await updateEnvConcurrencyLimits({ ...staging, organization, project });
      created++;
    } else {
      await updateEnvConcurrencyLimits({ ...stagingEnvironment, organization, project });
    }
  }

  return json({ success: true, created, total: organization.projects.length });
}
