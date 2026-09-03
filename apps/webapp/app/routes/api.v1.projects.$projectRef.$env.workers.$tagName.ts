import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetWorkerByTagResponse } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env as $env } from "~/env.server";
import {
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  tagName: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    // Accepts a user-actor token as well as a PAT. There's no ability check here, so the
    // token's cap isn't enforced (matches PAT behavior).
    const authentication = await authenticateUatOrApiRequest(request);

    if (!authentication) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsedParams = ParamsSchema.safeParse(params);

    if (!parsedParams.success) {
      return json({ error: "Invalid Params" }, { status: 400 });
    }
    const { projectRef, env } = parsedParams.data;

    const triggerBranch = branchNameFromRequest(request);

    // An org-claim token lists tasks in any project of its org, so the agent can read a sibling
    // project's worker. Membership is `findProjectByRef` inside the resolve.
    const runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authentication.authenticationResult,
      projectRef,
      env,
      triggerBranch,
      { organizationScoped: true }
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
        queueConfig: true,
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
          queueConfig: task.queueConfig,
        })),
      },
      urls,
    };

    return json(response);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load worker by tag", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
