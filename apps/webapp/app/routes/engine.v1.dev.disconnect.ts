import { json } from "@remix-run/server-runtime";
import { Ratelimit } from "@upstash/ratelimit";
import { tryCatch } from "@trigger.dev/core";
import { DevDisconnectRequestBody } from "@trigger.dev/core/v3";
import { BulkActionId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { BulkActionNotificationType, BulkActionType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { RateLimiter } from "~/services/rateLimiter.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { commonWorker } from "~/v3/commonWorker.server";
import pMap from "p-map";

const CANCEL_REASON = "Dev session ended (CLI exited)";

// Below this threshold, cancel runs inline with pMap.
// Above it, create a bulk action and process asynchronously.
const BULK_ACTION_THRESHOLD = 25;

// Maximum number of runs that can be cancelled in a single disconnect call.
const MAX_RUNS = 500;

// Rate limit: 5 calls per minute per environment
const disconnectRateLimiter = new RateLimiter({
  keyPrefix: "dev-disconnect",
  limiter: Ratelimit.fixedWindow(5, "1 m"),
  logFailure: true,
});

const { action } = createActionApiRoute(
  {
    body: DevDisconnectRequestBody,
    maxContentLength: 1024 * 256, // 256KB
    method: "POST",
  },
  async ({ authentication, body }) => {
    // Only allow dev environments — this endpoint uses finalizeRun which
    // skips PENDING_CANCEL and immediately finalizes executing runs.
    if (authentication.environment.type !== "DEVELOPMENT") {
      return json({ error: "This endpoint is only available for dev environments" }, { status: 403 });
    }

    const environmentId = authentication.environment.id;

    // Rate limit per environment
    const rateLimitResult = await disconnectRateLimiter.limit(environmentId);
    if (!rateLimitResult.success) {
      return json(
        { error: "Rate limit exceeded", retryAfter: Math.ceil((rateLimitResult.reset - Date.now()) / 1000) },
        { status: 429 }
      );
    }

    if (body.runFriendlyIds.length > MAX_RUNS) {
      return json(
        { error: `A maximum of ${MAX_RUNS} runs can be cancelled per request` },
        { status: 400 }
      );
    }

    const { runFriendlyIds } = body;

    if (runFriendlyIds.length === 0) {
      return json({ cancelled: 0 }, { status: 200 });
    }

    logger.info("Dev disconnect: cancelling runs", {
      environmentId,
      runCount: runFriendlyIds.length,
    });

    // For small numbers of runs, cancel inline
    if (runFriendlyIds.length <= BULK_ACTION_THRESHOLD) {
      const cancelled = await cancelRunsInline(runFriendlyIds, environmentId);
      return json({ cancelled }, { status: 200 });
    }

    // For large numbers, create a bulk action to process asynchronously
    const bulkActionId = await createBulkCancelAction(
      runFriendlyIds,
      authentication.environment.project.id,
      environmentId
    );

    logger.info("Dev disconnect: created bulk action for large run set", {
      environmentId,
      bulkActionId,
      runCount: runFriendlyIds.length,
    });

    return json({ cancelled: 0, bulkActionId }, { status: 200 });
  }
);

async function cancelRunsInline(
  runFriendlyIds: string[],
  environmentId: string
): Promise<number> {
  const runIds = runFriendlyIds.map((fid) => RunId.toId(fid));

  const runs = await prisma.taskRun.findMany({
    where: {
      id: { in: runIds },
      runtimeEnvironmentId: environmentId,
    },
    select: {
      id: true,
      engine: true,
      friendlyId: true,
      status: true,
      createdAt: true,
      completedAt: true,
      taskEventStore: true,
    },
  });

  let cancelled = 0;
  const cancelService = new CancelTaskRunService(prisma);

  await pMap(
    runs,
    async (run) => {
      const [error, result] = await tryCatch(
        cancelService.call(run, { reason: CANCEL_REASON, finalizeRun: true })
      );

      if (error) {
        logger.error("Dev disconnect: failed to cancel run", {
          runId: run.id,
          error,
        });
      } else if (result && !result.alreadyFinished) {
        cancelled++;
      }
    },
    { concurrency: 10 }
  );

  logger.info("Dev disconnect: completed inline cancellation", {
    environmentId,
    cancelled,
    total: runFriendlyIds.length,
  });

  return cancelled;
}

async function createBulkCancelAction(
  runFriendlyIds: string[],
  projectId: string,
  environmentId: string
): Promise<string> {
  const { id, friendlyId } = BulkActionId.generate();

  await prisma.bulkActionGroup.create({
    data: {
      id,
      friendlyId,
      projectId,
      environmentId,
      name: "Dev session disconnect",
      type: BulkActionType.CANCEL,
      params: { runId: runFriendlyIds, finalizeRun: true },
      queryName: "bulk_action_v1",
      totalCount: runFriendlyIds.length,
      completionNotification: BulkActionNotificationType.NONE,
    },
  });

  await commonWorker.enqueue({
    id: `processBulkAction-${id}`,
    job: "processBulkAction",
    payload: { bulkActionId: id },
  });

  return friendlyId;
}

export { action };
