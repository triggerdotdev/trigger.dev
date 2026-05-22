import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { logger } from "~/services/logger.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import {
  isInitialBufferedSubscriptionRequest,
  recordRealtimeBufferedSubscription,
} from "~/v3/mollifier/mollifierTelemetry.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) => {
      const pgRun = await $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runId,
          runtimeEnvironmentId: authentication.environment.id,
        },
        include: {
          batch: {
            select: {
              friendlyId: true,
            },
          },
        },
      });
      if (pgRun) return pgRun;

      // Buffered fallback. If the run is sitting in the mollifier buffer
      // (no PG row yet), open the Electric subscription anyway: the
      // shape stream returns an empty initial snapshot, and when the
      // drainer INSERTs the PG row Electric streams it to the client.
      // Without this branch the route 404s, ShapeStream stops on the
      // first response, and the hook silently hangs even after the run
      // materialises (no auto-recovery).
      const synthetic = await findRunByIdWithMollifierFallback({
        runId: params.runId,
        environmentId: authentication.environment.id,
        organizationId: authentication.environment.organizationId,
      });
      if (!synthetic) return null;

      // Shape findResource expects: friendlyId, taskIdentifier, runTags,
      // batch (for authorization), and id (for streamRun's WHERE clause).
      // The synthetic.id is derived from friendlyId via RunId — the same
      // value engine.trigger will write when the drainer materialises
      // this run, so the Electric subscription matches on INSERT.
      // `__bufferedDwellMs` flags this resource as buffer-sourced for
      // the loader body's observability hook below.
      return {
        id: synthetic.id,
        friendlyId: synthetic.friendlyId,
        taskIdentifier: synthetic.taskIdentifier ?? "",
        runTags: synthetic.runTags,
        batch: null as { friendlyId: string } | null,
        __bufferedDwellMs: Date.now() - synthetic.createdAt.getTime(),
      };
    },
    authorization: {
      action: "read",
      resource: (run) => {
        const resources = [
          { type: "runs", id: run.friendlyId },
          { type: "tasks", id: run.taskIdentifier },
          ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
        ];
        if (run.batch?.friendlyId) {
          resources.push({ type: "batch", id: run.batch.friendlyId });
        }
        return anyResource(resources);
      },
    },
  },
  async ({ authentication, request, resource: run, apiVersion }) => {
    // Observability for buffered-window subscriptions. The gate keeps
    // the counter at one tick per subscription instead of one tick per
    // ~20s live-poll iteration (see `isInitialBufferedSubscriptionRequest`).
    const bufferedDwellMs = (run as { __bufferedDwellMs?: number }).__bufferedDwellMs;
    if (
      typeof bufferedDwellMs === "number" &&
      isInitialBufferedSubscriptionRequest(request.url)
    ) {
      recordRealtimeBufferedSubscription(authentication.environment.id);
      logger.info("mollifier.realtime.buffered_subscription", {
        runId: run.friendlyId,
        envId: authentication.environment.id,
        bufferDwellMs: bufferedDwellMs,
      });
    }

    return realtimeClient.streamRun(
      request.url,
      authentication.environment,
      run.id,
      apiVersion,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined,
      // Propagate abort on client disconnect so the upstream Electric long-poll
      // fetch is cancelled too. Without this, undici buffers from the unconsumed
      // upstream response body accumulate until Electric's poll timeout, causing
      // steady RSS growth on api (see docs/runbooks for the H1 isolation test).
      getRequestAbortSignal()
    );
  }
);
