import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ImportEnvironmentVariablesRequestBody } from "@trigger.dev/core/v3";
import { parse } from "dotenv";
import { z } from "zod";
import {
  authenticateProjectApiKeyOrPersonalAccessToken,
  authenticatedEnvironmentForAuthentication,
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

  const authenticationResult = await authenticateProjectApiKeyOrPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.slug
  );

  const repository = new EnvironmentVariablesRepository();

  const body = await parseImportBody(request);

  const result = await repository.create(environment.project.id, {
    override: typeof body.override === "boolean" ? body.override : false,
    environmentIds: [environment.id],
    variables: Object.entries(body.variables).map(([key, value]) => ({
      key,
      value,
    })),
  });

  if (result.success) {
    return json({ success: true });
  } else {
    return json({ error: result.error, variableErrors: result.variableErrors }, { status: 400 });
  }
}

async function parseImportBody(request: Request): Promise<ImportEnvironmentVariablesRequestBody> {
  const contentType = request.headers.get("content-type") ?? "application/json";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();

    const file = formData.get("variables");
    const override = formData.get("override") === "true";

    if (file instanceof File) {
      const buffer = await file.arrayBuffer();

      const variables = parse(Buffer.from(buffer));

      return { variables, override };
    } else {
      throw json({ error: "Invalid file" }, { status: 400 });
    }
  } else {
    const rawBody = await request.json();

    const body = ImportEnvironmentVariablesRequestBody.safeParse(rawBody);

    if (!body.success) {
      throw json({ error: "Invalid body" }, { status: 400 });
    }

    return body.data;
  }
}
