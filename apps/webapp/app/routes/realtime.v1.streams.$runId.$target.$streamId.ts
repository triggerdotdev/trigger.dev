import { z } from "zod";
import { $replica } from "~/db.server";
import { relayRealtimeStreams } from "~/services/realtime/relayRealtimeStreams.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
  target: z.enum(["self", "parent", "root"]),
  streamId: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
  },
  async ({ request, params, authentication }) => {
    const run = await $replica.taskRun.findFirst({
      where: {
        friendlyId: params.runId,
        runtimeEnvironmentId: authentication.environment.id,
      },
      select: {
        id: true,
        friendlyId: true,
        parentTaskRun: {
          select: {
            friendlyId: true,
          },
        },
        rootTaskRun: {
          select: {
            friendlyId: true,
          },
        },
      },
    });

    if (!run) {
      return new Response("Run not found", { status: 404 });
    }

    const targetId =
      params.target === "self"
        ? run.friendlyId
        : params.target === "parent"
        ? run.parentTaskRun?.friendlyId
        : run.rootTaskRun?.friendlyId;

    if (!targetId) {
      return new Response("Target not found", { status: 404 });
    }

    if (!request.body) {
      return new Response("No body provided", { status: 400 });
    }

    const resumeFromChunk = request.headers.get("X-Resume-From-Chunk");
    const resumeFromChunkNumber = resumeFromChunk ? parseInt(resumeFromChunk, 10) : undefined;

    return relayRealtimeStreams.ingestData(
      request.body,
      targetId,
      params.streamId,
      resumeFromChunkNumber
    );
  }
);

const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: false,
    corsStrategy: "none",
    findResource: async (params, authentication) => {
      return $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runId,
          runtimeEnvironmentId: authentication.environment.id,
        },
        select: {
          id: true,
          friendlyId: true,
          parentTaskRun: {
            select: {
              friendlyId: true,
            },
          },
          rootTaskRun: {
            select: {
              friendlyId: true,
            },
          },
        },
      });
    },
  },
  async ({ request, params, resource: run }) => {
    if (!run) {
      return new Response("Run not found", { status: 404 });
    }

    const targetId =
      params.target === "self"
        ? run.friendlyId
        : params.target === "parent"
        ? run.parentTaskRun?.friendlyId
        : run.rootTaskRun?.friendlyId;

    if (!targetId) {
      return new Response("Target not found", { status: 404 });
    }

    // Handle HEAD request to get last chunk index
    if (request.method !== "HEAD") {
      return new Response("Only HEAD requests are allowed for this endpoint", { status: 405 });
    }

    const lastChunkIndex = await relayRealtimeStreams.getLastChunkIndex(targetId, params.streamId);

    return new Response(null, {
      status: 200,
      headers: {
        "X-Last-Chunk-Index": lastChunkIndex.toString(),
      },
    });
  }
);

export { action, loader };
