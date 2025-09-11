import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { UpdateEnvironmentVariableRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  authenticateRequest,
  authenticatedEnvironmentForAuthentication,
} from "~/services/apiAuth.server";
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

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug
  );

  // Find the environment variable
  const variable = await prisma.environmentVariable.findFirst({
    where: {
      key: parsedParams.data.name,
      projectId: environment.project.id,
    },
  });

  if (!variable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  switch (request.method.toUpperCase()) {
    case "DELETE": {
      const result = await repository.deleteValue(environment.project.id, {
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

      const result = await repository.edit(environment.project.id, {
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

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug
  );

  // Find the environment variable
  const variable = await prisma.environmentVariable.findFirst({
    where: {
      key: parsedParams.data.name,
      projectId: environment.project.id,
    },
  });

  if (!variable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  const repository = new EnvironmentVariablesRepository();

  const variables = await repository.getEnvironmentWithRedactedSecrets(
    environment.project.id,
    environment.id,
    environment.parentEnvironmentId ?? undefined
  );

  const environmentVariable = variables.find((v) => v.key === parsedParams.data.name);

  if (!environmentVariable) {
    return json({ error: "Environment variable not found" }, { status: 404 });
  }

  return json({
    name: environmentVariable.key,
    value: environmentVariable.value,
    isSecret: environmentVariable.isSecret,
  });
}
