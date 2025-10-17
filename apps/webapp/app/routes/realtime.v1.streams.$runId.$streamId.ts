import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { relayRealtimeStreams } from "~/services/realtime/relayRealtimeStreams.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const $params = ParamsSchema.parse(params);

  if (!request.body) {
    return new Response("No body provided", { status: 400 });
  }

  const resumeFromChunk = request.headers.get("X-Resume-From-Chunk");
  const resumeFromChunkNumber = resumeFromChunk ? parseInt(resumeFromChunk, 10) : undefined;

  return relayRealtimeStreams.ingestData(
    request.body,
    $params.runId,
    $params.streamId,
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
    return relayRealtimeStreams.streamResponse(
      request,
      run.friendlyId,
      params.streamId,
      authentication.environment,
      request.signal
    );
  }
);
