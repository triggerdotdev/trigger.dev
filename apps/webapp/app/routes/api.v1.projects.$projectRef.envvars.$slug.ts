import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { CreateEnvironmentVariableRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  slug: z.string(),
});

export async function action({ params, request }: ActionFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const jsonBody = await request.json();

  const body = CreateEnvironmentVariableRequestBody.safeParse(jsonBody);

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const project = await findProjectByRef(parsedParams.data.projectRef, user.id);

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      slug: parsedParams.data.slug,
    },
  });

  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  const result = await repository.create(project.id, user.id, {
    overwrite: true,
    environmentIds: [environment.id],
    variables: [
      {
        key: body.data.name,
        value: body.data.value,
      },
    ],
  });

  if (result.success) {
    return json({ success: true });
  } else {
    return json({ error: result.error, variableErrors: result.variableErrors }, { status: 400 });
  }
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

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

  const project = await findProjectByRef(parsedParams.data.projectRef, user.id);

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      slug: parsedParams.data.slug,
    },
  });

  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  const variables = await repository.getEnvironment(project.id, user.id, environment.id, true);

  return json(variables);
}
