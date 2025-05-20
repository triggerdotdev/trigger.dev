import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";

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

  const { projectRef } = parsedParams.data;

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      environments: {
        some: {
          id: authenticationResult.environment.id,
        },
      },
    },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const envVarEnvironment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: authenticationResult.environment.id,
    },
    include: {
      parentEnvironment: true,
    },
  });

  if (!envVarEnvironment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const variables = await resolveVariablesForEnvironment(
    envVarEnvironment,
    envVarEnvironment.parentEnvironment ?? undefined
  );

  return json({
    variables: variables.reduce((acc: Record<string, string>, variable) => {
      acc[variable.key] = variable.value;
      return acc;
    }, {}),
  });
}
