import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { type GetWorkerByTagResponse } from "@trigger.dev/core/v3/schemas";
import { env as $env } from "~/env.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
} from "~/services/apiAuth.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  tagName: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

const HeadersSchema = z.object({
  "x-trigger-branch": z.string().optional(),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateRequest(request, {
    personalAccessToken: true,
    organizationAccessToken: true,
    apiKey: false,
  });

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }
  const { projectRef, env } = parsedParams.data;

  const parsedHeaders = HeadersSchema.safeParse(Object.fromEntries(request.headers));
  const triggerBranch = parsedHeaders.success ? parsedHeaders.data["x-trigger-branch"] : undefined;

  const runtimeEnv = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    projectRef,
    env,
    triggerBranch
  );

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

  const urls = {
    runs: `${$env.APP_ORIGIN}${v3RunsPath(
      { slug: runtimeEnv.organization.slug },
      { slug: runtimeEnv.project.slug },
      { slug: runtimeEnv.slug },
      { versions: [currentWorker.version] }
    )}`,
  };

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
    urls,
  };

  return json(response);
}
