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

  const url = new URL(request.url);
  const branch = url.searchParams.get("branch");

  const envResult = await getEnvironmentFromEnv({
    projectId: project.id,
    userId: env,
    env,
    branch,
  });

  if (!envResult.success) {
    return json({ error: envResult.error }, { status: 404 });
  }

  const runtimeEnv = envResult.environment;

  const result: GetProjectEnvResponse = {
    apiKey: runtimeEnv.apiKey,
    name: project.name,
    apiUrl: processEnv.APP_ORIGIN,
    projectId: project.id,
  };

  return json(result);
}

async function getEnvironmentFromEnv({
  projectId,
  userId,
  env,
  branch,
}: {
  projectId: string;
  userId: string;
  env: ParamsSchema["env"];
  branch: string | null;
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

  if (env !== "preview") {
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: {
        projectId,
        slug: env === "staging" ? "stg" : "prod",
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

  // Preview branch

  if (!branch) {
    return {
      success: false,
      error: "Preview branch not specified",
    };
  }

  // Get the parent preview environment first
  const previewEnvironment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId,
      slug: "preview",
    },
  });

  if (!previewEnvironment) {
    return {
      success: false,
      error:
        "You don't have Preview branches enabled for this project. Visit the dashboard to enable them",
    };
  }

  // Now get the branch environment
  const branchEnvironment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId,
      parentEnvironmentId: previewEnvironment.id,
      branchName: branch,
    },
  });

  if (!branchEnvironment) {
    return {
      success: false,
      error: `Preview branch "${branch}" not found`,
    };
  }

  return {
    success: true,
    environment: branchEnvironment,
  };
}
