import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { marqs } from "~/v3/marqs/index.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

const RequestBodySchema = z.object({
  envMaximumConcurrencyLimit: z.number(),
  orgMaximumConcurrencyLimit: z.number(),
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

  const parsedParams = ParamsSchema.parse(params);

  const rawBody = await request.json();
  const body = RequestBodySchema.parse(rawBody);

  const environment = await prisma.runtimeEnvironment.update({
    where: {
      id: parsedParams.environmentId,
    },
    data: {
      maximumConcurrencyLimit: body.envMaximumConcurrencyLimit,
      organization: {
        update: {
          data: {
            maximumConcurrencyLimit: body.orgMaximumConcurrencyLimit,
          },
        },
      },
    },
    include: {
      organization: true,
      project: true,
    },
  });

  await marqs?.updateEnvConcurrencyLimits(environment);

  return json({ success: true });
}
