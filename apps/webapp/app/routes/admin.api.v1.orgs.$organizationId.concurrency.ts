import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { marqs } from "~/v3/marqs/index.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const RequestBodySchema = z.object({
  organization: z.number(),
  development: z.number().optional(),
  staging: z.number().optional(),
  production: z.number().optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Next authenticate the request
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

  if (!user.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  const rawBody = await request.json();
  const body = RequestBodySchema.parse(rawBody);

  if (!body.development && !body.staging && !body.production) {
    return json({ error: "At least one environment limit must be provided" }, { status: 400 });
  }

  //update org
  const organization = await prisma.organization.update({
    where: {
      id: organizationId,
    },
    data: {
      maximumConcurrencyLimit: body.organization,
    },
  });

  //update environments
  const environments = await prisma.runtimeEnvironment.findMany({
    where: {
      organizationId: organizationId,
      project: {
        version: "V3",
      },
    },
  });

  for (const environment of environments) {
    let limit: number | undefined = undefined;
    switch (environment.type) {
      case "DEVELOPMENT": {
        limit = body.development;
        break;
      }
      case "STAGING": {
        limit = body.staging;
        break;
      }
      case "PRODUCTION": {
        limit = body.production;
        break;
      }
    }

    if (!limit) continue;

    const modifiedEnvironment = await prisma.runtimeEnvironment.update({
      where: {
        id: environment.id,
      },
      data: {
        maximumConcurrencyLimit: limit,
      },
      include: {
        project: true,
      },
    });

    await updateEnvConcurrencyLimits({ ...modifiedEnvironment, organization });
  }

  return json({ success: true });
}
