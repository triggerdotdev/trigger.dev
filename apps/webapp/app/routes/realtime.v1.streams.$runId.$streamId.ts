import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

// Plain action for backwards compatibility with older clients that don't send auth headers
export async function action({ request, params }: ActionFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return new Response("Invalid parameters", { status: 400 });
  }

  const { runId, streamId } = parsedParams.data;

  // Look up the run without environment scoping for backwards compatibility
  const run = await $replica.taskRun.findFirst({
    where: {
      friendlyId: runId,
    },
    select: {
      id: true,
      friendlyId: true,
      runtimeEnvironment: {
        include: {
          project: true,
          organization: true,
          orgMember: true,
        },
      },
    },
  });

  if (!run) {
    return new Response("Run not found", { status: 404 });
  }

  // Extract client ID from header, default to "default" if not provided
  const clientId = request.headers.get("X-Client-Id") || "default";
  const streamVersion = request.headers.get("X-Stream-Version") || "v1";

  if (!request.body) {
    return new Response("No body provided", { status: 400 });
  }

  const resumeFromChunk = request.headers.get("X-Resume-From-Chunk");
  let resumeFromChunkNumber: number | undefined = undefined;
  if (resumeFromChunk) {
    const parsed = parseInt(resumeFromChunk, 10);
    if (isNaN(parsed) || parsed < 0) {
      return new Response(`Invalid X-Resume-From-Chunk header value: ${resumeFromChunk}`, {
        status: 400,
      });
    }
    resumeFromChunkNumber = parsed;
  }

  // The runtimeEnvironment from the run is already in the correct shape for AuthenticatedEnvironment
  const realtimeStream = getRealtimeStreamInstance(run.runtimeEnvironment, streamVersion);

  return realtimeStream.ingestData(
    request.body,
    run.friendlyId,
    streamId,
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

    const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds") ?? undefined;
    const timeoutInSeconds = timeoutInSecondsRaw ? parseInt(timeoutInSecondsRaw) : undefined;

    if (timeoutInSeconds && isNaN(timeoutInSeconds)) {
      return new Response("Invalid timeout seconds", { status: 400 });
    }

    if (timeoutInSeconds && timeoutInSeconds < 1) {
      return new Response("Timeout seconds must be greater than 0", { status: 400 });
    }

    if (timeoutInSeconds && timeoutInSeconds > 600) {
      return new Response("Timeout seconds must be less than 600", { status: 400 });
    }

    const realtimeStream = getRealtimeStreamInstance(
      authentication.environment,
      run.realtimeStreamsVersion
    );

    return realtimeStream.streamResponse(request, run.friendlyId, params.streamId, request.signal, {
      lastEventId,
      timeoutInSeconds,
    });
  }
);
