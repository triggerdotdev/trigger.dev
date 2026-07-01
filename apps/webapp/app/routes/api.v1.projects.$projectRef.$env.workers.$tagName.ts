import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { isUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { type GetWorkerByTagResponse } from "@trigger.dev/core/v3/schemas";
import { env as $env } from "~/env.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import {
  type AuthenticationResult,
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  tagName: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    // A delegated user-actor token authenticates as its user, like a PAT.
    // Resolve it here (the shared `authenticateRequest` deliberately doesn't
    // accept UATs) so the dashboard agent can list a project's deployed tasks
    // on the user's behalf. Identity-only, same as the PAT path below — there's
    // no ability check on this route, so the cap isn't enforced here (matches
    // PAT behavior).
    const bearer = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    let authenticationResult: AuthenticationResult | undefined;
    if (bearer && isUserActorToken(bearer)) {
      const claims = await verifyUserActorToken($env.SESSION_SECRET, bearer);
      if (!claims) {
        return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
      }
      authenticationResult = { type: "personalAccessToken", result: { userId: claims.userId } };
    } else {
      authenticationResult = await authenticateRequest(request, {
        personalAccessToken: true,
        organizationAccessToken: true,
        apiKey: false,
      });
    }

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsedParams = ParamsSchema.safeParse(params);

    if (!parsedParams.success) {
      return json({ error: "Invalid Params" }, { status: 400 });
    }
    const { projectRef, env } = parsedParams.data;

    const triggerBranch = branchNameFromRequest(request);

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
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load worker by tag", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
