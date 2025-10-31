import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
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

    if (request.method === "PUT") {
      // This is the "create" endpoint
      const updatedRun = await prisma.taskRun.update({
        where: {
          friendlyId: targetId,
          runtimeEnvironmentId: authentication.environment.id,
        },
        data: {
          realtimeStreams: {
            push: params.streamId,
          },
        },
        select: {
          realtimeStreamsVersion: true,
        },
      });

      const realtimeStream = getRealtimeStreamInstance(
        authentication.environment,
        updatedRun.realtimeStreamsVersion
      );

      const { responseHeaders } = await realtimeStream.initializeStream(targetId, params.streamId);

      return json(
        {
          version: updatedRun.realtimeStreamsVersion,
        },
        { status: 202, headers: responseHeaders }
      );
    } else {
      // Extract client ID from header, default to "default" if not provided
      const clientId = request.headers.get("X-Client-Id") || "default";
      const streamVersion = request.headers.get("X-Stream-Version") || "v1";

      if (!request.body) {
        return new Response("No body provided", { status: 400 });
      }

      const resumeFromChunk = request.headers.get("X-Resume-From-Chunk");
      const resumeFromChunkNumber = resumeFromChunk ? parseInt(resumeFromChunk, 10) : undefined;

      const realtimeStream = getRealtimeStreamInstance(authentication.environment, streamVersion);

      return realtimeStream.ingestData(
        request.body,
        targetId,
        params.streamId,
        clientId,
        resumeFromChunkNumber
      );
    }
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
  async ({ request, params, resource: run, authentication }) => {
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

    // Extract client ID from header, default to "default" if not provided
    const clientId = request.headers.get("X-Client-Id") || "default";
    const streamVersion = request.headers.get("X-Stream-Version") || "v1";

    const realtimeStream = getRealtimeStreamInstance(authentication.environment, streamVersion);

    const lastChunkIndex = await realtimeStream.getLastChunkIndex(
      targetId,
      params.streamId,
      clientId
    );

    return new Response(null, {
      status: 200,
      headers: {
        "X-Last-Chunk-Index": lastChunkIndex.toString(),
      },
    });
  }
);

export { action, loader };
