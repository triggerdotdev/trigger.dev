import { ActionFunctionArgs, json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { scheduleEngine } from "~/v3/scheduleEngine.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

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

  const parsedParams = ParamsSchema.parse(params);

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: parsedParams.environmentId,
    },
    include: {
      organization: true,
      project: true,
    },
  });

  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const results = await scheduleEngine.recoverSchedulesInEnvironment(
    environment.projectId,
    environment.id
  );

  return json({
    success: true,
    results,
  });
}
