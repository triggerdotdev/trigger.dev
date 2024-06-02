import { LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { Registry } from "prom-client";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { registerProjectMetrics } from "./registerProjectMetrics.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const validatedParams = ParamsSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      externalRef: validatedParams.projectRef,
      organization: {
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  const registry = new Registry();
  // Return prometheus metrics for the project (queues)

  await registerProjectMetrics(registry, project.id, authenticationResult.userId);

  return new Response(await registry.metrics(), {
    headers: {
      "Content-Type": registry.contentType,
    },
  });
}
