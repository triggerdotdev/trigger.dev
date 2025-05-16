import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { GetProjectEnvResponse } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env as processEnv } from "~/env.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod"]),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("projects get env", { url: request.url });

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef, env } = parsedParams.data;

  const project =
    env === "dev"
      ? await prisma.project.findUnique({
          where: {
            externalRef: projectRef,
            organization: {
              members: {
                some: {
                  userId: authenticationResult.userId,
                },
              },
            },
          },
          include: {
            environments: {
              where: {
                orgMember: {
                  userId: authenticationResult.userId,
                },
              },
            },
          },
        })
      : await prisma.project.findUnique({
          where: {
            externalRef: projectRef,
            organization: {
              members: {
                some: {
                  userId: authenticationResult.userId,
                },
              },
            },
          },
          include: {
            environments: {
              where: {
                slug: env === "prod" ? "prod" : "stg",
              },
            },
          },
        });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.environments.length) {
    return json(
      { error: `Environment "${env}" not found or is unsupported for this project.` },
      { status: 404 }
    );
  }

  const runtimeEnv = project.environments[0];

  const result: GetProjectEnvResponse = {
    apiKey: runtimeEnv.apiKey,
    name: project.name,
    apiUrl: processEnv.API_ORIGIN ?? processEnv.APP_ORIGIN,
    projectId: project.id,
  };

  return json(result);
}
