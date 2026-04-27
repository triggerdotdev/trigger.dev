import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { CreateEnvironmentVariableRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import {
  authenticateRequest,
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
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

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug,
    branchNameFromRequest(request)
  );

  const jsonBody = await request.json();

  const body = CreateEnvironmentVariableRequestBody.safeParse(jsonBody);

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const repository = new EnvironmentVariablesRepository();

  const result = await repository.create(environment.project.id, {
    override: true,
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

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug,
    branchNameFromRequest(request)
  );

  const repository = new EnvironmentVariablesRepository();

  const variables = await repository.getEnvironmentWithRedactedSecrets(
    environment.project.id,
    environment.id,
    environment.parentEnvironmentId ?? undefined
  );

  return json(
    variables.map((variable) => ({
      name: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    }))
  );
}
