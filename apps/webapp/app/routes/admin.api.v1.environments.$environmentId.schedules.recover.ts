import { ActionFunctionArgs, json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { scheduleEngine } from "~/v3/scheduleEngine.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

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
