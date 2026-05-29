import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ImportEnvironmentVariablesRequestBody } from "@trigger.dev/core/v3";
import { parse } from "dotenv";
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

  const repository = new EnvironmentVariablesRepository();

  const body = await parseImportBody(request);

  const result = await repository.create(environment.project.id, {
    override: typeof body.override === "boolean" ? body.override : false,
    environmentIds: [environment.id],
    // Pass parent environment ID so new variables can inherit isSecret from parent
    parentEnvironmentId: environment.parentEnvironmentId ?? undefined,
    variables: Object.entries(body.variables).map(([key, value]) => ({
      key,
      value,
    })),
    lastUpdatedBy: body.source,
  });

  // Only sync parent variables if this is a branch environment
  if (environment.parentEnvironmentId && body.parentVariables) {
    const parentResult = await repository.create(environment.project.id, {
      override: typeof body.override === "boolean" ? body.override : false,
      environmentIds: [environment.parentEnvironmentId],
      variables: Object.entries(body.parentVariables).map(([key, value]) => ({
        key,
        value,
      })),
      lastUpdatedBy: body.source,
    });

    let childFailure = !result.success ? result : undefined;
    let parentFailure = !parentResult.success ? parentResult : undefined;

    if (result.success || parentResult.success) {
      return json({ success: true });
    } else {
      return json(
        {
          error: childFailure?.error || parentFailure?.error || "Unknown error",
          variableErrors: childFailure?.variableErrors || parentFailure?.variableErrors,
        },
        { status: 400 }
      );
    }
  }

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
