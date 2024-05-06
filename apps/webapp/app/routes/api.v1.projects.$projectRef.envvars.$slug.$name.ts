import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { UpdateEnvironmentVariableRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  slug: z.string(),
  name: z.string(),
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

  // Find the environment variable
  const variable = await prisma.environmentVariable.findFirst({
    where: {
      key: parsedParams.data.name,
      projectId: project.id,
    },
  });

  if (!variable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  switch (request.method.toUpperCase()) {
    case "DELETE": {
      const result = await repository.deleteValue(project.id, user.id, {
        id: variable.id,
        environmentId: environment.id,
      });

      if (result.success) {
        return json({ success: true });
      } else {
        return json({ error: result.error }, { status: 400 });
      }
    }
    case "PUT":
    case "POST": {
      const jsonBody = await request.json();

      const body = UpdateEnvironmentVariableRequestBody.safeParse(jsonBody);

      if (!body.success) {
        return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
      }

      const result = await repository.edit(project.id, user.id, {
        values: [
          {
            value: body.data.value,
            environmentId: environment.id,
          },
        ],
        id: variable.id,
        keepEmptyValues: true,
      });

      if (result.success) {
        return json({ success: true });
      } else {
        return json({ error: result.error }, { status: 400 });
      }
    }
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

  // Find the environment variable
  const variable = await prisma.environmentVariable.findFirst({
    where: {
      key: parsedParams.data.name,
      projectId: project.id,
    },
  });

  if (!variable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  const variables = await repository.getEnvironment(project.id, user.id, environment.id, true);

  const environmentVariable = variables.find((v) => v.key === parsedParams.data.name);

  if (!environmentVariable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  return json({
    value: environmentVariable.value,
  });
}
