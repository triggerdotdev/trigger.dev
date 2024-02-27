import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { CreateBackgroundWorkerService } from "~/v3/services/createBackgroundWorker.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const { projectRef } = parsedParams.data;

  const project = await prisma.project.findUnique({
    where: {
      externalRef: projectRef,
      environments: {
        some: {
          id: authenticatedEnv.id,
        },
      },
    },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  const variables = await repository.getEnvironmentVariables(project.id, authenticatedEnv.id);

  return json({
    variables: variables.reduce((acc: Record<string, string>, variable) => {
      acc[variable.key] = variable.value;
      return acc;
    }, {}),
  });
}
