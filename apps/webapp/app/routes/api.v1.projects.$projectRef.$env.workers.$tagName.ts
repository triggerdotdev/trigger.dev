import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { getEnvironmentFromEnv } from "./api.v1.projects.$projectRef.$env";
import { GetWorkerByTagResponse } from "@trigger.dev/core/v3/schemas";

const ParamsSchema = z.object({
  projectRef: z.string(),
  tagName: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
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
    userId: authenticationResult.userId,
    env,
  });

  if (!envResult.success) {
    return json({ error: envResult.error }, { status: 404 });
  }

  const runtimeEnv = envResult.environment;

  const currentWorker = await findCurrentWorkerFromEnvironment(
    {
      id: runtimeEnv.id,
      type: runtimeEnv.type,
    },
    $replica,
    params.tagName
  );

  if (!currentWorker) {
    return json({ error: "Worker not found" }, { status: 404 });
  }

  const tasks = await $replica.backgroundWorkerTask.findMany({
    where: {
      workerId: currentWorker.id,
    },
    select: {
      friendlyId: true,
      slug: true,
      filePath: true,
      triggerSource: true,
      createdAt: true,
      payloadSchema: true,
    },
    orderBy: {
      slug: "asc",
    },
  });

  // Prepare the response object
  const response: GetWorkerByTagResponse = {
    worker: {
      id: currentWorker.friendlyId,
      version: currentWorker.version,
      engine: currentWorker.engine,
      sdkVersion: currentWorker.sdkVersion,
      cliVersion: currentWorker.cliVersion,
      tasks: tasks.map((task) => ({
        id: task.friendlyId,
        slug: task.slug,
        filePath: task.filePath,
        triggerSource: task.triggerSource,
        createdAt: task.createdAt,
        payloadSchema: task.payloadSchema,
      })),
    },
  };

  // Optionally validate the response before returning (for type safety)
  // WorkerResponseSchema.parse(response);

  return json(response);
}
