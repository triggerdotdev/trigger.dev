import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";

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

    const targetRun = await prisma.taskRun.findFirst({
      where: {
        friendlyId: targetId,
        runtimeEnvironmentId: authentication.environment.id,
      },
      select: {
        realtimeStreams: true,
        realtimeStreamsVersion: true,
        completedAt: true,
        id: true,
      },
    });

    if (!targetRun) {
      return new Response("Run not found", { status: 404 });
    }

    if (targetRun.completedAt) {
      return new Response("Cannot append to a realtime stream on a completed run", {
        status: 400,
      });
    }

    if (!targetRun.realtimeStreams.includes(params.streamId)) {
      await prisma.taskRun.update({
        where: {
          id: targetRun.id,
        },
        data: {
          realtimeStreams: {
            push: params.streamId,
          },
        },
      });
    }

    const part = await request.text();

    const realtimeStream = getRealtimeStreamInstance(
      authentication.environment,
      targetRun.realtimeStreamsVersion
    );

    const partId = request.headers.get("X-Part-Id") ?? nanoid(7);

    const [appendError] = await tryCatch(
      realtimeStream.appendPart(part, partId, targetId, params.streamId)
    );

    if (appendError) {
      if (appendError instanceof ServiceValidationError) {
        return json(
          {
            ok: false,
            error: appendError.message,
          },
          { status: appendError.status ?? 422 }
        );
      } else {
        return json(
          {
            ok: false,
            error: appendError.message,
          },
          { status: 500 }
        );
      }
    }

    return json(
      {
        ok: true,
      },
      { status: 200 }
    );
  }
);

export { action };
