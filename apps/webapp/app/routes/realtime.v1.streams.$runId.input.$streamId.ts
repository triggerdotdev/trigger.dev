import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  getInputStreamWaitpoint,
  deleteInputStreamWaitpoint,
} from "~/services/inputStreamWaitpointCache.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { engine } from "~/v3/runEngine.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

const BodySchema = z.object({
  data: z.unknown(),
});

// POST: Send data to an input stream
const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    maxContentLength: 1024 * 1024, // 1MB max
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "write",
      resource: (params) => ({ inputStreams: params.runId }),
      superScopes: ["write:inputStreams", "write:all", "admin"],
    },
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
        completedAt: true,
        realtimeStreamsVersion: true,
      },
    });

    if (!run) {
      return json({ ok: false, error: "Run not found" }, { status: 404 });
    }

    if (run.completedAt) {
      return json(
        { ok: false, error: "Cannot send to input stream on a completed run" },
        { status: 400 }
      );
    }

    const body = BodySchema.safeParse(await request.json());

    if (!body.success) {
      return json({ ok: false, error: "Invalid request body" }, { status: 400 });
    }

    const realtimeStream = getRealtimeStreamInstance(
      authentication.environment,
      run.realtimeStreamsVersion
    );

    // Build the input stream record (raw user data, no wrapper)
    const recordId = `inp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const record = JSON.stringify(body.data.data);

    // Append the record to the per-stream S2 stream (auto-creates on first write)
    await realtimeStream.appendPart(
      record,
      recordId,
      run.friendlyId,
      `$trigger.input:${params.streamId}`
    );

    // Check Redis cache for a linked .wait() waitpoint (fast, no DB hit if none)
    // Get first, complete, then delete — so the mapping survives if completeWaitpoint throws
    const waitpointId = await getInputStreamWaitpoint(params.runId, params.streamId);
    if (waitpointId) {
      await engine.completeWaitpoint({
        id: waitpointId,
        output: {
          value: JSON.stringify(body.data.data),
          type: "application/json",
          isError: false,
        },
      });
      await deleteInputStreamWaitpoint(params.runId, params.streamId);
    }

    return json({ ok: true });
  }
);

// GET: SSE stream for reading input stream data (used by the in-task SSE tail)
const loader = createLoaderApiRoute(
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
    const lastEventId = request.headers.get("Last-Event-ID") || undefined;

    const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds") ?? undefined;
    const timeoutInSeconds =
      timeoutInSecondsRaw !== undefined ? parseInt(timeoutInSecondsRaw, 10) : undefined;

    if (timeoutInSeconds !== undefined && isNaN(timeoutInSeconds)) {
      return new Response("Invalid timeout seconds", { status: 400 });
    }

    if (timeoutInSeconds !== undefined && timeoutInSeconds < 1) {
      return new Response("Timeout seconds must be greater than 0", { status: 400 });
    }

    if (timeoutInSeconds !== undefined && timeoutInSeconds > 600) {
      return new Response("Timeout seconds must be less than 600", { status: 400 });
    }

    const realtimeStream = getRealtimeStreamInstance(
      authentication.environment,
      run.realtimeStreamsVersion
    );

    // Read from the internal S2 stream name (prefixed to avoid user stream collisions)
    return realtimeStream.streamResponse(
      request,
      run.friendlyId,
      `$trigger.input:${params.streamId}`,
      request.signal,
      {
        lastEventId,
        timeoutInSeconds,
      }
    );
  }
);

export { action, loader };
