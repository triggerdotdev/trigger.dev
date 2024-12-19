import { z } from "zod";
import { $replica } from "~/db.server";
import { relayRealtimeStreams } from "~/services/realtime/relayRealtimeStreams.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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
    if (!request.body) {
      return new Response("No body provided", { status: 400 });
    }

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

    return relayRealtimeStreams.ingestData(request.body, targetId, params.streamId);
  }
);

export { action };
