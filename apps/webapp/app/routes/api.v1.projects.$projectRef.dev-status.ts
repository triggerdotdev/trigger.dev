import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { getEnvironmentFromEnv } from "./api.v1.projects.$projectRef.$env";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      organization: {
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
    },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const envResult = await getEnvironmentFromEnv({
    projectId: project.id,
    userId: authenticationResult.userId,
    env: "dev",
  });

  if (!envResult.success) {
    return json({ error: envResult.error }, { status: 404 });
  }

  const runtimeEnv = envResult.environment;

  const isConnected = await devPresence.isConnected(runtimeEnv.id);

  return json({ isConnected });
}
