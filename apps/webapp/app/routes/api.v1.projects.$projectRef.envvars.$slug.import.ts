import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ImportEnvironmentVariablesRequestBody } from "@trigger.dev/core/v3";
import { parse } from "dotenv";
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

  const body = await parseImportBody(request);

  const result = await repository.create(project.id, user.id, {
    overwrite: body.overwrite === true ? true : false,
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

  if (contentType.includes("application/octet-stream")) {
    // We have a "dotenv" formatted file uploaded
    const buffer = await request.arrayBuffer();

    const variables = parse(Buffer.from(buffer));

    const overwrite = request.headers.get("x-overwrite") === "true";

    return { variables, overwrite };
  } else {
    const rawBody = await request.json();

    const body = ImportEnvironmentVariablesRequestBody.safeParse(rawBody);

    if (!body.success) {
      throw json({ error: "Invalid body" }, { status: 400 });
    }

    return body.data;
  }
}
