import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  authenticateRequest,
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { personalAccessTokenUnauthorizedResponse } from "~/services/personalAccessToken.server";
import { getHttpContext, getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import {
  createBoundedReadQueue,
  inflateSourceFilesForResponse,
  WorkerSourceTooLargeError,
} from "~/v3/workerSourceFiles.server";

// Reads per process are capped and held until their response is sent: each can hold up to the
// per-worker limit several times over. Built on first use so importing the route reads no env.
const sourceReads = () =>
  singleton("workerSourceReads", () =>
    createBoundedReadQueue({
      concurrency: env.WORKER_SOURCE_READ_CONCURRENCY,
      maxPending: env.WORKER_SOURCE_READ_MAX_PENDING,
      maxHoldMs: env.WORKER_SOURCE_READ_MAX_HOLD_MS,
    })
  );

const ParamsSchema = z.object({
  projectRef: z.string(),
  envSlug: z.string(),
  version: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    const authenticationResult = await authenticateRequest(request, {
      personalAccessToken: true,
      organizationAccessToken: true,
      apiKey: true,
    });

    if (!authenticationResult) {
      return personalAccessTokenUnauthorizedResponse(request, "Invalid or Missing API key");
    }

    const environment = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      parsedParams.data.projectRef,
      parsedParams.data.envSlug,
      branchNameFromRequest(request)
    );

    // Legacy API-key authentication already scopes the caller to its environment.
    if (authenticationResult.type !== "apiKey") {
      const denied = await authorizePatEnvironmentAccess({
        request,
        authType: authenticationResult.type,
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        envType: environment.type,
        resource: "deployments",
        action: "read",
      });
      if (denied) return denied;
    }

    const [readError, read] = await tryCatch(
      sourceReads().run(
        { signal: getRequestAbortSignal(), onHoldExpired: getHttpContext()?.closeConnection },
        () => workerResponse(environment.id, parsedParams.data.version)
      )
    );

    if (readError instanceof WorkerSourceTooLargeError) {
      return json(
        { error: "This worker's source files are too large to return." },
        { status: 413 }
      );
    }
    if (readError) throw readError;

    if (read.status === "busy") {
      return json(
        { error: "Too many worker source reads in progress. Try again shortly." },
        { status: 429, headers: { "Retry-After": "5" } }
      );
    }
    if (read.status === "aborted") {
      return new Response(null, { status: 499 });
    }

    return read.value;
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load background worker", { error, projectRef: params.projectRef });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}

async function workerResponse(environmentId: string, version: string) {
  const backgroundWorker = await prisma.backgroundWorker.findFirst({
    where: {
      runtimeEnvironmentId: environmentId,
      version,
    },
    include: {
      tasks: true,
      files: true,
    },
  });

  if (!backgroundWorker) {
    return json({ error: "Background worker not found" }, { status: 404 });
  }

  const files = await inflateSourceFilesForResponse(backgroundWorker.files);

  // Group task slugs by fileId from the already-loaded tasks (which are fetched
  // via the indexed workerId relation) instead of loading files.tasks, which
  // queries BackgroundWorkerTask by the unindexed fileId column.
  const taskSlugsByFileId = new Map<string, Set<string>>();
  for (const task of backgroundWorker.tasks) {
    if (!task.fileId) {
      continue;
    }
    const slugs = taskSlugsByFileId.get(task.fileId) ?? new Set<string>();
    slugs.add(task.slug);
    taskSlugsByFileId.set(task.fileId, slugs);
  }

  return json({
    id: backgroundWorker.friendlyId,
    version: backgroundWorker.version,
    cliVersion: backgroundWorker.cliVersion,
    sdkVersion: backgroundWorker.sdkVersion,
    contentHash: backgroundWorker.contentHash,
    createdAt: backgroundWorker.createdAt,
    updatedAt: backgroundWorker.updatedAt,
    tasks: backgroundWorker.tasks.map((task) => ({
      id: task.slug,
      exportName: task.exportName ?? "@deprecated",
      filePath: task.filePath,
      source: task.triggerSource,
      retryConfig: task.retryConfig,
      queueConfig: task.queueConfig,
    })),
    files: files.map(({ file, contents }) => ({
      id: file.friendlyId,
      filePath: file.filePath,
      contentHash: file.contentHash,
      contents,
      tasks: Array.from(taskSlugsByFileId.get(file.id) ?? []),
    })),
  });
}
