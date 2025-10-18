import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { v1RealtimeStreams } from "~/services/realtime/v1StreamsGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const $params = ParamsSchema.parse(params);

  // Extract client ID from header, default to "default" if not provided
  const clientId = request.headers.get("X-Client-Id") || "default";

  // Handle HEAD request to get last chunk index for this client
  if (request.method === "HEAD") {
    const lastChunkIndex = await v1RealtimeStreams.getLastChunkIndex(
      $params.runId,
      $params.streamId,
      clientId
    );

    return new Response(null, {
      status: 200,
      headers: {
        "X-Last-Chunk-Index": lastChunkIndex.toString(),
      },
    });
  }

  if (!request.body) {
    return new Response("No body provided", { status: 400 });
  }

  const resumeFromChunk = request.headers.get("X-Resume-From-Chunk");
  const resumeFromChunkNumber = resumeFromChunk ? parseInt(resumeFromChunk, 10) : undefined;

  return v1RealtimeStreams.ingestData(
    request.body,
    $params.runId,
    $params.streamId,
    clientId,
    resumeFromChunkNumber
  );
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      return $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runId,
          runtimeEnvironmentId: auth.environment.id,
        },
        include: {
          batch: {
            select: {
              friendlyId: true,
            },
          },
        },
      });
    },
    authorization: {
      action: "read",
      resource: (run) => ({
        runs: run.friendlyId,
        tags: run.runTags,
        batch: run.batch?.friendlyId,
        tasks: run.taskIdentifier,
      }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, request, resource: run, authentication }) => {
    // Get Last-Event-ID header for resuming from a specific position
    const lastEventId = request.headers.get("Last-Event-ID") || undefined;

    return v1RealtimeStreams.streamResponse(
      request,
      run.friendlyId,
      params.streamId,
      request.signal,
      lastEventId
    );
  }
);
