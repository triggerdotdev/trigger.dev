import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getAndDeleteInputStreamWaitpoint } from "~/services/inputStreamWaitpointCache.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { engine } from "~/v3/runEngine.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

const BodySchema = z.object({
  data: z.unknown(),
});

const { action, loader } = createActionApiRoute(
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

    // Build the input stream record
    const recordId = `inp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const record = JSON.stringify({
      stream: params.streamId,
      data: body.data.data,
      ts: Date.now(),
      id: recordId,
    });

    // Append the record to the multiplexed __input stream (auto-creates on first write)
    await realtimeStream.appendPart(record, recordId, run.friendlyId, "__input");

    // Check Redis cache for a linked .wait() waitpoint (fast, no DB hit if none)
    const waitpointId = await getAndDeleteInputStreamWaitpoint(params.runId, params.streamId);
    if (waitpointId) {
      await engine.completeWaitpoint({
        id: waitpointId,
        output: {
          value: JSON.stringify(body.data.data),
          type: "application/json",
          isError: false,
        },
      });
    }

    return json({ ok: true });
  }
);

export { action, loader };
