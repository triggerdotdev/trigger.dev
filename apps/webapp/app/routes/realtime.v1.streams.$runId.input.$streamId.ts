import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

const BodySchema = z.object({
  data: z.unknown(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    maxContentLength: 1024 * 1024, // 1MB max
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
        hasInputStream: true,
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

    // Lazily create the input stream on first send
    if (!run.hasInputStream) {
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { hasInputStream: true },
      });

      await realtimeStream.initializeStream(run.friendlyId, "__input");
    }

    // Build the input stream record
    const recordId = `inp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const record = JSON.stringify({
      stream: params.streamId,
      data: body.data.data,
      ts: Date.now(),
      id: recordId,
    });

    // Append the record to the multiplexed __input stream
    await realtimeStream.appendPart(record, recordId, run.friendlyId, "__input");

    return json({ ok: true });
  }
);

export { action };
