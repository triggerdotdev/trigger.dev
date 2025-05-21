import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetProjectEnvResponse } from "@trigger.dev/core/v3";
import { type RuntimeEnvironment } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env as processEnv } from "~/env.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

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

  const project = await prisma.project.findFirst({
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
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const envResult = await getEnvironmentFromEnv({
    projectId: project.id,
    userId: env,
    env,
  });

  if (!envResult.success) {
    return json({ error: envResult.error }, { status: 404 });
  }

  const runtimeEnv = envResult.environment;

  const result: GetProjectEnvResponse = {
    apiKey: runtimeEnv.apiKey,
    name: project.name,
    apiUrl: processEnv.API_ORIGIN ?? processEnv.APP_ORIGIN,
    projectId: project.id,
  };

  return json(result);
}

async function getEnvironmentFromEnv({
  projectId,
  userId,
  env,
}: {
  projectId: string;
  userId: string;
  env: ParamsSchema["env"];
}): Promise<
  | {
      success: true;
      environment: RuntimeEnvironment;
    }
  | {
      success: false;
      error: string;
    }
> {
  if (env === "dev") {
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: {
        projectId,
        orgMember: {
          userId: userId,
        },
      },
    });

    if (!environment) {
      return {
        success: false,
        error: "Dev environment not found",
      };
    }

    return {
      success: true,
      environment,
    };
  }

  let slug: "stg" | "prod" | "preview" = "prod";
  switch (env) {
    case "staging":
      slug = "stg";
      break;
    case "prod":
      slug = "prod";
      break;
    case "preview":
      slug = "preview";
      break;
    default:
      break;
  }

  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId,
      slug,
    },
  });

  if (!environment) {
    return {
      success: false,
      error: `${env === "staging" ? "Staging" : "Production"} environment not found`,
    };
  }

  return {
    success: true,
    environment,
  };
}
